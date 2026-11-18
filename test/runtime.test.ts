import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { providerPatch } from "../src/catalog.ts";
import { profilePatch } from "../src/plugin-patch.ts";

const executable = process.execPath;

const exec = promisify(execFile);
const moduleUrl = (path: string) => pathToFileURL(resolve(path)).href;
async function nativeTest(
  executable: string,
  body: string,
  patches: object[] = [],
  preload?: string,
) {
  const directory = await mkdtemp(join(tmpdir(), "lazydsh-native-"));
  const patch = join(directory, "patch.json");
  const driver = join(directory, "driver.mjs");
  try {
    await writeFile(
      patch,
      JSON.stringify([
        ...providerPatch(),
        ...profilePatch("lazydshTest"),
        { insert: [{ name: resolve("test/fixtures/native-runtime.ts") }] },
        ...patches,
      ]),
    );
    await writeFile(
      driver,
      `
      import assert from "node:assert/strict";
      import { writeFile, readFile, realpath, rm, mkdir } from "node:fs/promises";
      import { join } from "node:path";
      import { ensureProfile, runProfile } from ${JSON.stringify(moduleUrl("src/dsh-boot.ts"))};
      import { loadLayeredEnv } from ${JSON.stringify(import.meta.resolve("@deepseek-ai/dsh-app-boot"))};
      import { models } from ${JSON.stringify(moduleUrl("src/catalog.ts"))};
      import { historyRows } from ${JSON.stringify(moduleUrl("src/history.ts"))};
      const directory = ${JSON.stringify(directory)};
      ${preload ?? 'globalThis.fetch = async () => { throw new Error("Network disabled in test"); };'}
      ensureProfile("lazydsh", ["@deepseek-ai/dsh-base"]);
      const {ctx, shutdown} = await runProfile({profile:"lazydsh",patchFiles:[${JSON.stringify(patch)}],args:[],environment:loadLayeredEnv("test")});
      const runtime = ctx.get("lazydshTest");
      try { ${body}; console.log("native-ok"); }
      catch(error) { process.exitCode = 1; console.error(error); }
      finally { await shutdown.shutdown(process.exitCode ? 1 : 0); }
    `,
    );
    const result = await exec(executable, [driver], {
      cwd: process.cwd(),
      timeout: 90_000,
      maxBuffer: 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        DSH_HOME: join(directory, "home"),
        TEST_WORKSPACE: directory,
        DSH_TELEMETRY_DISABLED: "1",
      },
    });
    assert.match(result.stdout, /native-ok/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("providers, commands and lifecycle", async () => {
  await nativeTest(
    executable,
    `
    ctx.commands.register({name:"hello",description:"Test command",handler:({rawInput})=>({kind:"success",text:rawInput.trim()})});
    ctx.commands.register({name:"image",description:"Image test",input:{hint:"[image]",attachments:true},handler:({attachments})=>({kind:"success",text:String(attachments.length)})});
    ctx.commands.register({name:"question",description:"Question test",handler:async({agent,signal})=>({
      kind:"success",text:JSON.stringify(await ctx.userQuestions.ask({agent,signal,questions:[{id:"pet",question:"Dog or cat?",options:[{label:"Dog"},{label:"Cat"}]}]}))
    })});
    for (const provider of ["deepseek-official","opencode-go","opencode","openai-codex"]) {
      let prompts = 0;
      const id = await runtime.open({provider,model:models(provider)[0].id}, { onAuth: async () => { prompts++; return "test-only"; },
        onUserQuestion: async (request) => ({answers:request.questions.map(question=>({id:question.id,selected:["Cat"]}))}),
        onApproval: async () => ({outcome:"rejected"}),
      });
      assert.ok(id);
      const imagePath = join(directory, "pixel.gif");
      await writeFile(imagePath, Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"));
      const image = await runtime.attach(imagePath);
      assert.equal((await runtime.run("/image", undefined, [image])).finalResponse, "1");
      const answer = JSON.parse((await runtime.run("/question")).finalResponse);
      assert.deepEqual(answer.answers, [{id:"pet",selected:["Cat"]}]);
      if (provider === "deepseek-official" || provider === "opencode-go") {
        await runtime.authenticate();
        assert.ok(prompts > 0);
      }
      assert.equal((await runtime.choices("mode","plan")).current,"plan");
      assert.equal((await runtime.choices("mode","default")).current,"default");
      await assert.rejects(runtime.choices("mode","bad"),/Unknown mode/);
      const permissions = await runtime.choices("permissions");
      assert.ok(permissions.options.length);
      await runtime.choices("permissions",permissions.current);
      assert.equal(await runtime.cd(directory),await realpath(directory));
      assert.ok((await runtime.choices("directories")).options.some(item=>item.value===".."));
      await assert.rejects(runtime.cd(join(directory,"missing")),/./);
      const commands = await runtime.commands();
      for (const name of ["compact","permission","plan","goal","feedback","export","effort","hello"]) assert.ok(commands.some(item=>item.name===name),name);
      assert.equal((await runtime.run("/hello from plugin")).finalResponse,"from plugin");
      assert.equal((await runtime.run("/plan")).finishReason,"completed");
      await runtime.run("/plan off");
      await runtime.run("/goal");
      const effort = await runtime.efforts();
      if (effort.options.length) {
        await runtime.run("/effort "+effort.options[0].id);
        assert.equal((await runtime.efforts()).current,effort.options[0].id);
      }
      await runtime.run("/effort default");
      await assert.rejects(runtime.run("/effort unsupported"), /Unsupported effort/);
      await runtime.run("/feedback test");
      const destination=join(directory,provider+".zip");
      assert.equal((await runtime.run("/export "+destination)).finishReason,"completed");
      assert.equal((await readFile(destination)).subarray(0,2).toString(),"PK");
      await assert.rejects(runtime.run("/export "+destination), /EEXIST/);
      await assert.rejects(runtime.run("/unknown"),/Unknown dsh command/);
      await runtime.close();
    }
    await assert.rejects(runtime.run("hello"),/No model selected/);
  `,
  );
});

test("streaming, authentication and history", async () => {
  const patches = [
    {
      id: "llm-pi-ai",
      config: {
        providers: {
          "opencode-go": {
            api: "openai-completions",
            baseURL: "https://lazydsh-test.invalid/v1",

            models: ["test-model", "test-model-2"].map((id) => ({
              id,
              contextWindow: 131072,
              maxTokens: 4096,
              reasoningEfforts: { low: "low", high: "high" },
            })),
          },
        },
      },
    },
  ];
  await nativeTest(
    executable,
    `
    const route = {provider:"opencode-go",model:"test-model"};
    let authCalls = 0;
    let approvalCalls = 0;
    const approvals = [];
    ctx.on("agent/pre-step", async ({agent}, next) => {
      assert.equal(await ctx.approval.request({agent, toolName:"test", reason:"pre-step"}), "rejected");
      return next();
    });
    const callbacks = { onAuth: async () => { authCalls++; reject = false; return "test-only"; },
      onApproval: async (params) => { approvalCalls++; approvals.push(params); return {outcome:"rejected"}; },
    };
    const id=await runtime.open(route,callbacks);
    assert.equal(requests.length,0);
    await runtime.run("/effort high");
    const file=join(directory,"reference.txt"); await writeFile(file,"attachment contents");
    const attachment=await runtime.attach(file);
    assert.equal(attachment.type,"file");
    await assert.rejects(runtime.attach(join(directory,"missing")),/ENOENT/);
    const order=[];
    const result=await runtime.run("Say hello.",event=>order.push(event),[attachment]);
    assert.equal(result.finalResponse,"Hello from dsh.");
    assert.equal(authCalls,1);
    assert.ok(approvalCalls > 0);
    assert.ok(approvals.every(item=>item.toolName==="test"));
    assert.ok(approvals.some(item=>item.reason==="pre-step"));
    assert.equal(requests.length,2);
    assert.ok(requests.every(req=>req.messages.some(item=>JSON.stringify(item).includes("Say hello."))));
    const delta=order.findIndex(event=>event.method==="assistant.delta");
    const final=order.findIndex(event=>event.method==="session.event" && event.params.event.type==="assistant/message");
    assert.ok(delta>=0 && final>delta);
    assert.equal(order.filter(event=>event.method==="assistant.delta").map(event=>event.params.text).join(""),"Hello from dsh.");
    assert.equal(order.filter(event=>event.method==="assistant.reasoning").map(event=>event.params.text).join(""),"Brief reasoning");
    assert.ok(order.some(event=>event.method==="lazydsh.thinking" && event.params.type==="usage"));
    assert.equal((await runtime.stats()).latest.outputTokens,4);
    await runtime.open(route);
    assert.ok((await runtime.choices("sessions")).options.some(item=>item.value===id));
    await runtime.open(route,{...callbacks,resume:id});
    const rows=historyRows(await runtime.history(),id);
    assert.ok(rows.some(row=>"kind" in row && row.kind==="user" && row.text.includes("Say hello.")));
    assert.ok(rows.some(row=>"kind" in row && row.kind==="assistant" && row.text==="Hello from dsh."));
    assert.equal((await runtime.efforts()).current,"high");
    await runtime.open({...route,model:"test-model-2"},{...callbacks,resume:id});
    assert.equal(runtime.session.id,id);
    const second=await runtime.run("Again.");
    assert.equal(second.finalResponse,"Hello from dsh.");
    assert.equal((await runtime.stats()).totals.outputTokens,8);
    assert.equal(requests.length,3);
    const firstChunk = Promise.withResolvers();
    const pending = runtime.run("Cancel this", event => {
      if (event.method === "assistant.delta") firstChunk.resolve();
    });
    await firstChunk.promise;
    assert.equal((await runtime.run("/effort low")).finishReason, "completed");
    assert.equal((await runtime.efforts()).current, "low");
    assert.equal((await runtime.stats()).model.effort,"low");
    assert.equal((await runtime.run("/plan")).finishReason,"completed");
    assert.equal((await runtime.choices("mode")).current,"plan");
    assert.equal((await runtime.run("/plan off")).finishReason,"completed");
    assert.equal((await runtime.choices("mode")).current,"default");
    assert.ok((await runtime.stats()).totals.outputTokens >= 8);
    await runtime.cancel();
    assert.equal((await pending).finishReason, "aborted");
    assert.equal(runtime.session.id, id);
    assert.equal((await runtime.run("After cancellation")).finishReason, "completed");
    assert.equal(requests.length,5);
    const points = runtime.forkPoints();
    assert.ok(points.length >= 2);
    await assert.rejects(runtime.forkSession(-1), /Choose a completed turn/);
    const forked = await runtime.forkSession(Number(points[0].value));
    assert.notEqual(forked,id);
    const forkRows = historyRows(await runtime.history(), forked);
    assert.ok(forkRows.some(row => row.kind === "user" && row.text.includes("Say hello.")));
    assert.ok(!forkRows.some(row => row.kind === "user" && row.text === "Again."));
    await runtime.open(route, {...callbacks,resume:forked});
    assert.equal(runtime.session.id,forked);
    await runtime.open(route, callbacks);
    reject = true;
    const beforeCheck = (await runtime.history()).filter(event=>event.type==="user/message").length;
    let initialShown = false;
    const stats = await runtime.stats(true, snapshot => {
      assert.equal(requests.length,5);
      assert.equal(snapshot.model.name,"test-model");
      assert.equal(snapshot.session.id,runtime.session.id);
      assert.equal(snapshot.latest,undefined);
      initialShown = true;
    });
    assert.equal(initialShown,true);
    assert.equal(stats.model.provider,"opencode-go");
    assert.equal(stats.model.name,"test-model");
    assert.equal(stats.session.id,runtime.session.id);
    assert.equal(stats.settings.mode,"Default");
    assert.ok(stats.settings.permission);
    assert.equal(stats.limits.windows[0].left,75);
    assert.equal(stats.latestSource,"connection check");
    assert.equal(stats.latest.outputTokens,4);
    assert.equal(stats.context.contextWindow,131072);
    assert.equal(stats.totals.outputTokens,0);
    assert.equal((await runtime.history()).filter(event=>event.type==="user/message").length,beforeCheck);
    assert.equal(authCalls,2);
    assert.equal(requests.length,7);
    badRequest = true;
    await assert.rejects(runtime.stats(true), /INVALID_REQUEST|400/);
    assert.equal(authCalls,2);
    await runtime.close();
  `,
    patches,
    `
    process.env.OPENCODE_API_KEY="expired-test-only";
    let reject=true;
    let badRequest=false;
    const requests=[];
    globalThis.fetch=async(input,init)=>{
      const request=new Request(input,init);
      if(request.url==="https://opencode.ai/zen/go/v1/usage") return Response.json({usage:{rolling:{percent:25,resetsAt:"2026-11-15T00:00:00Z"}}});
      assert.ok(request.url.startsWith("https://lazydsh-test.invalid/"),request.url);
      const body=JSON.parse(await request.text()); requests.push(body);
      assert.ok(request.headers.get("user-agent"));
      assert.ok(request.headers.get("x-opencode-session"),"missing OpenCode session header");
      if(reject) return new Response("Unauthorized",{status:401});
      if(badRequest) return new Response("Invalid request",{status:400});
      const slow = body.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("Cancel this")) &&
        !body.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("After cancellation"));
      if (slow) {
        const stream = new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({id:"test",object:"chat.completion.chunk",model:"test-model",choices:[{index:0,delta:{role:"assistant",content:"Partial."},finish_reason:null}]})+'\\n\\n'));
          const abort = () => controller.error(new DOMException("Aborted", "AbortError"));
          if (request.signal.aborted) abort();
          else request.signal.addEventListener("abort", abort, {once:true});
        }});
        return new Response(stream,{headers:{"content-type":"text/event-stream"}});
      }
      const chunks=[
        {choices:[{index:0,delta:{role:"assistant",reasoning_content:"Brief reasoning"},finish_reason:null}]},
        {choices:[{index:0,delta:{content:"Hello "},finish_reason:null}]},
        {choices:[{index:0,delta:{content:"from dsh."},finish_reason:null}]},
        {choices:[{index:0,delta:{},finish_reason:"stop"}],usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14}},
      ];
      const stream=new ReadableStream({async start(controller){
        for(const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode("data: "+JSON.stringify({id:"test",object:"chat.completion.chunk",model:"test-model",...chunk})+"\\n\\n"));
          await new Promise(resolve=>setTimeout(resolve,10));
        }
        controller.enqueue(new TextEncoder().encode("data: [DONE]\\n\\n")); controller.close();
      }});
      return new Response(stream,{headers:{"content-type":"text/event-stream"}});
    };
  `,
  );
});

test("sessions, jobs and file references", async () => {
  await nativeTest(
    executable,
    `
    await mkdir(join(directory,".agents/skills/test-skill"),{recursive:true});
    await writeFile(join(directory,".agents/skills/test-skill/SKILL.md"),"---\\nname: test-skill\\ndescription: Reference test skill\\n---\\nRead the test skill.");
    await writeFile(join(directory,"reference file.txt"),"test");
    const route = {provider:"deepseek-official",model:models("deepseek-official")[0].id};
    assert.deepEqual((await runtime.choices("sessions")).options, []);
    const first = await runtime.open(route);
    assert.equal(await runtime.sessionDirectory(first), directory);
    await mkdir(join(directory,"changed"),{recursive:true});
    const changed = await runtime.cd(join(directory,"changed"));
    assert.equal(await runtime.sessionDirectory(first), changed);
    await runtime.cd(directory);
    // A pre-title checkpoint has a null title row; listing must still read the log.
    await ctx.get("sessionProjectionCache").write(runtime.session);
    assert.equal(await runtime.renameSession(first,"First session"),"First session");
    await ctx.sessionPersistence.flush();
    assert.ok((await runtime.sessions()).some(item => item.id === first && item.title === "First session"));
    await runtime.manageSession(first,"pin");
    assert.ok((await runtime.sessions()).find(item=>item.id===first).pinned);
    await runtime.manageSession(first,"unpin");
    assert.ok(!(await runtime.sessions()).find(item=>item.id===first).pinned);
    await runtime.close();
    assert.ok((await runtime.choices("sessions")).options.some(item=>item.value===first));
    await runtime.open(route);
    const current=runtime.session.id;
    assert.equal(await runtime.renameSession(first,"Renamed saved session"),"Renamed saved session");
    assert.equal(runtime.session.id,current);
    await runtime.manageSession(first,"archive");
    assert.ok(!(await runtime.choices("sessions")).options.some(item=>item.value===first));
    assert.ok((await runtime.sessions()).find(item=>item.id===first).archived);
    await assert.rejects(runtime.open(route,{resume:first}),/archived/);
    assert.equal(runtime.session.id,current);
    await runtime.manageSession(first,"restore");
    assert.ok((await runtime.choices("sessions")).options.some(item=>item.value===first));
    let cancelled=0;
    const pending=Promise.withResolvers();
    const job=ctx.jobs.start({kind:"bash",owner:runtime.session.id,label:"Test background job",run(handle){
      handle.append("output line\\n");
      return {done:pending.promise,cancel(){cancelled++;pending.resolve({status:"killed"});}};
    }});
    assert.ok((await runtime.jobs()).some(item=>item.id===job));
    assert.match(await runtime.job(job),/Test background job.*running/);
    assert.match(await runtime.job(job),/output line/);
    assert.match(await runtime.job(job),/output line/); // Observer reads do not consume the model cursor.
    await assert.rejects(runtime.job("missing",true),/not found/);
    const foreign=await ctx.agents.create({agentOptions:route});
    const other=Promise.withResolvers();
    const foreignJob=ctx.jobs.start({kind:"bash",owner:foreign.agent.session.id,label:"Foreign job",run(){return {done:other.promise,cancel(){other.resolve({status:"killed"});}};}});
    assert.ok(!(await runtime.jobs()).some(item=>item.id===foreignJob));
    await assert.rejects(runtime.job(foreignJob,true),/not found/);
    assert.equal(await runtime.job(job,true),"requested");
    await pending.promise;
    assert.equal(cancelled,1);
    await foreign.dispose();
    await runtime.cd(directory);
    const refs=await runtime.references("reference",new AbortController().signal);
    assert.ok(refs.some(item=>item.value==='@"reference file.txt"'),JSON.stringify(refs));
    const skills=await runtime.references("skill:test-skill",new AbortController().signal);
    assert.ok(skills.some(item=>item.value==="/test-skill"),JSON.stringify(skills));
    await runtime.close();
  `,
  );
});

test("sending without credentials asks for /login", async () => {
  await nativeTest(
    executable,
    `
    const route = {provider:"opencode-go",model:models("opencode-go")[0].id};
    assert.equal(await runtime.hasCredentials("opencode-go"), false);
    assert.equal((await runtime.credentialSource("opencode-go")).kind, "none");
    assert.equal(await runtime.hasCredentials("deepseek-official"), false);
    assert.equal(await runtime.hasCredentials("openai-codex"), false);
    // A route this build does not know must not be blocked by the preflight.
    assert.equal(await runtime.hasCredentials("custom-route"), true);
    assert.equal((await runtime.credentialSource("custom-route")).kind, "unknown");
    assert.equal(await runtime.logout("opencode-go"), undefined);
    await runtime.open(route);
    await assert.rejects(runtime.run("hello"), /Not logged in to opencode-go.*\\/login opencode-go/);
    await assert.rejects(
      runtime.run("hello", undefined, [], {authenticate:false}),
      /lazydsh login opencode-go/,
    );
    assert.equal((await runtime.history()).filter(event => event.type === "user/message").length, 0);
    await runtime.authenticate(undefined, {provider:"opencode-go",onAuth:async(_method,params)=>
      params.kind === "select" ? "api-key" : "test-only"
    });
    assert.equal(await runtime.hasCredentials("opencode-go"), true);
    assert.equal((await runtime.credentialSource("opencode-go")).kind, "store");
    assert.equal(
      await runtime.authenticate(undefined, {provider:"opencode-go",onAuth:async()=>"replacement"}),
      "Already logged in to opencode-go.",
    );
    await runtime.close();
  `,
  );
});

test("reports credentials read from the environment", async () => {
  await nativeTest(
    executable,
    `
    const source = await runtime.credentialSource("openrouter");
    assert.equal(source.kind, "environment");
    assert.equal(source.ref, "OPENROUTER_API_KEY");
    assert.equal(source.label, "OPENROUTER_API_KEY (environment)");
    assert.equal(await runtime.hasCredentials("openrouter"), true);
    assert.equal(
      await runtime.authenticate(undefined, {provider:"openrouter",onAuth:async()=>"replacement"}),
      "Already logged in to openrouter.",
    );
    assert.deepEqual(await runtime.logout("openrouter"), ["OPENROUTER_API_KEY"]);
  `,
    [],
    `process.env.OPENROUTER_API_KEY="test-only"; globalThis.fetch=async()=>{throw new Error("Network disabled in test")};`,
  );
});

test("login and logout", async () => {
  await nativeTest(
    executable,
    `
    const before = ctx.agents.list().length;
    const choices = runtime.authProviders();
    for (const provider of ["deepseek-official","opencode-go","opencode","openai-codex"]) assert.ok(choices.some(item=>item.value===provider),provider);
    assert.ok(choices.every(item=>item.label && item.description));
    const prompts=[];
    await runtime.authenticate(undefined, {provider:"openrouter",onAuth:async(method,params)=>{
      prompts.push(params.kind);
      if(params.kind==="select") return "api-key";
      return "test-only-api-key";
    }});
    assert.ok(prompts.includes("select"));
    assert.ok(prompts.includes("secret"));
    assert.equal(ctx.agents.list().length,before);
    assert.equal((await ctx.credentials.readRecord("llm-pi-ai/openrouter")).key,"test-only-api-key");
    assert.equal(
      await runtime.authenticate(undefined, {provider:"openrouter",onAuth:async()=>"replacement"}),
      "Already logged in to openrouter.",
    );
    assert.equal((await ctx.credentials.readRecord("llm-pi-ai/openrouter")).key,"test-only-api-key");
    await runtime.logout("openrouter");
    assert.equal(await ctx.credentials.readRecord("llm-pi-ai/openrouter"),undefined);
    assert.equal(await runtime.logout("openrouter"), undefined);
    const backPrompts=[];
    let secrets=0;
    await runtime.authenticate(undefined,{provider:"openrouter",onAuth:async(_method,params)=>{
      backPrompts.push(params.kind);
      if(params.kind==="select") return "api-key";
      return ++secrets===1 ? null : "after-back-test-only";
    }});
    assert.deepEqual(backPrompts,["select","secret","select","secret"]);
    assert.equal((await ctx.credentials.readRecord("llm-pi-ai/openrouter")).key,"after-back-test-only");
    await runtime.logout("openrouter");
    const aborted=new AbortController();
    await assert.rejects(runtime.authenticate(aborted.signal,{provider:"openrouter",onAuth:async(_method,params)=>{
      if(params.kind==="select") return "api-key";
      aborted.abort();
      return null;
    }}),error=>error.name==="AbortError");
    assert.equal(await ctx.credentials.readRecord("llm-pi-ai/openrouter"),undefined);
    await runtime.authenticate(undefined,{provider:"deepseek-official",onAuth:async()=>"deepseek-test-only"});
    assert.equal((await ctx.credentials.resolve("DEEPSEEK_API_KEY")).value,"deepseek-test-only");
    assert.equal(
      await runtime.authenticate(undefined,{provider:"deepseek-official",onAuth:async()=>"replacement"}),
      "Already logged in to deepseek-official.",
    );
    await runtime.logout("deepseek-official");
    assert.equal(await ctx.credentials.resolve("DEEPSEEK_API_KEY"),undefined);
    assert.equal(await runtime.logout("deepseek-official"), undefined);
    assert.equal(ctx.agents.list().length,before);
    await assert.rejects(runtime.logout("missing-provider"),/Unknown provider/);
    let codexPrompt;
    await assert.rejects(runtime.authenticate(undefined,{provider:"openai-codex",onAuth:async(_method,params)=>{codexPrompt=params;return null;}}),/cancelled/);
    assert.equal(codexPrompt.message,"How would you like to log in to Codex?");
    assert.deepEqual(codexPrompt.options.map(item=>item.label),["Open a browser","Use a device code"]);
    assert.equal(ctx.agents.list().length,before);
  `,
  );
});
