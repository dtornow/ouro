/* boot.js --- One request, one round of eval. The model writes the loop. */

var engine = null;

var AGENT_SYSTEM =
  "You run inside this browser tab. Your only tool is eval. " +
  "To use it, wrap JavaScript in a tool_call block and add no other text:\n" +
  "<tool_call>\n1 + 1\n</tool_call>\n" +
  "The block is evaluated in the page. A reply without that block is final.";

function agentParse(text) {
  /* A tool call is a <tool_call> block. Its body is the JavaScript. */
  var calls = [];
  function take(body) {
    calls.push({
      id: "call_" + (calls.length + 1),
      type: "function",
      function: { name: "eval", arguments: JSON.stringify({ expression: body.trim() }) }
    });
  }
  var content = text.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g, function (_, body) {
    take(body);
    return "";
  });
  var open = content.match(/<tool_call>\s*([\s\S]*)$/);
  if (open) {
    take(open[1]);
    content = content.slice(0, open.index);
  }
  return { role: "assistant", content: content.trim(), tool_calls: calls };
}

async function agentPrompt(messages) {
  /* Send MESSAGES to the model in this tab. Return the assistant message.
     A tool call is message.tool_calls[].function, name "eval", arguments a
     JSON string {"expression":"..."}. To continue the turn, append the
     assistant message, then one {role:"tool", tool_call_id, content} per call. */
  if (!engine) throw new Error("The model is not loaded.");
  var stream = await engine.chat.completions.create({
    messages: [{ role: "system", content: AGENT_SYSTEM }].concat(messages),
    temperature: 0.2,
    max_tokens: 768,
    stream: true
  });
  var text = "";
  var chunk;
  for await (chunk of stream) {
    var choice = chunk.choices && chunk.choices[0];
    var delta = choice && choice.delta && choice.delta.content;
    if (!delta) continue;
    text += delta;
    if (typeof agentOnText === "function") agentOnText(text);
  }
  return agentParse(text);
}

function agentPrint(value) {
  if (typeof value === "undefined") return "undefined";
  if (typeof value === "string") return value;
  if (typeof value === "function") return Function.prototype.toString.call(value);
  try {
    return JSON.stringify(value);
  } catch (err) {
    return String(value);
  }
}

async function agentEval(expression) {
  /* Eval EXPRESSION in this page and return the printed result or error. */
  try {
    return agentPrint(await (0, eval)(expression));
  } catch (err) {
    return err && err.message ? err.message : String(err);
  }
}

async function agent(prompt) {
  /* Send PROMPT. Run any eval once, for side effects. The model does not
     see the results; the caller does. */
  var message = await agentPrompt([{ role: "user", content: prompt }]);
  var parts = [message.content || ""];
  var calls = message.tool_calls || [];
  var i;
  for (i = 0; i < calls.length; i++) {
    var call = calls[i];
    var fn = call.function || {};
    if (fn.name !== "eval") continue;
    var args;
    try {
      args = typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : (fn.arguments || {});
    } catch (err) {
      parts.push(err.message || String(err));
      continue;
    }
    parts.push(await agentEval(args.expression || ""));
  }
  return parts.join("");
}

function agentBootPrompt(source, task) {
  return (
    "You are running inside a browser tab. Your only tool, eval, evaluates JavaScript in this page. This is your harness:\n\n" +
    source +
    "\n\nThis call is a bootstrap: `agent` makes one request, runs your evals once for side effects, and drops their results. You will not see any eval result in this call, so do not explore. In a single eval, redefine `agent` so that it sends tool results back through `agentPrompt` and loops until you reply without calling a tool. Then call your new `agent` with the user's task:\n\n" +
    task
  );
}

async function agentBoot(task) {
  var response = await fetch("boot.js");
  if (!response.ok) throw new Error("Could not read the harness.");
  return agent(agentBootPrompt(await response.text(), task));
}

async function agentModel() {
  /* Half precision when the GPU has it. Full precision otherwise. */
  var adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("WebGPU is present, but no adapter is available.");
  if (adapter.features.has("shader-f16")) {
    return "Qwen2.5-0.5B-Instruct-q4f16_1-MLC";
  }
  return "Qwen2.5-0.5B-Instruct-q4f32_1-MLC";
}

async function agentLoad(onProgress) {
  if (engine) return;
  if (!navigator.gpu) {
    throw new Error("This browser has no WebGPU, so the model cannot run in the tab.");
  }
  var adapter = await navigator.gpu.requestAdapter();
  var info = adapter && (adapter.info || {});
  if (info && info.architecture === "swiftshader") {
    var cpu = await import("./wasm-engine.js");
    engine = await cpu.createEngine(onProgress);
    return;
  }
  var model = await agentModel();
  var webllm = await import("https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.86/+esm");
  engine = await webllm.CreateMLCEngine(model, {
    initProgressCallback: function (report) {
      if (onProgress) onProgress(report);
    }
  });
}
