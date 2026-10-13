/* CPU runtime for software WebGPU, which does not compute this model correctly. */

var MODEL = "onnx-community/Qwen2.5-0.5B-Instruct";

export async function createEngine(onProgress) {
  var transformers = await import("https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1");
  transformers.env.backends.onnx.wasm.numThreads = 1;
  var generator = await transformers.pipeline("text-generation", MODEL, {
    dtype: "q4",
    device: "wasm",
    progress_callback: function (report) {
      if (!onProgress || report.status !== "progress" || !report.total) return;
      onProgress({
        progress: report.loaded / report.total,
        text: report.file || ""
      });
    }
  });

  function chatMessages(messages) {
    return messages.map(function (message) {
      var content = typeof message.content === "string" ? message.content : JSON.stringify(message.content || "");
      if (message.role === "tool") return { role: "user", content: content };
      return { role: message.role, content: content };
    });
  }

  return {
    chat: {
      completions: {
        create: async function (request) {
          var messages = chatMessages(request.messages);
          var maxNew = request.max_tokens || 256;
          if (!request.stream) {
            var done = await generator(messages, { max_new_tokens: maxNew, do_sample: false });
            return { choices: [{ message: { content: done[0].generated_text.at(-1).content } }] };
          }
          var queue = [];
          var wake = null;
          var ended = false;
          var failed = null;
          var streamer = new transformers.TextStreamer(generator.tokenizer, {
            skip_prompt: true,
            skip_special_tokens: true,
            callback_function: function (text) {
              queue.push(text);
              if (wake) {
                var resume = wake;
                wake = null;
                resume();
              }
            }
          });
          var running = generator(messages, {
            max_new_tokens: maxNew,
            do_sample: false,
            streamer: streamer
          }).then(function () {
            ended = true;
            if (wake) wake();
          }, function (err) {
            failed = err;
            ended = true;
            if (wake) wake();
          });
          return (async function* () {
            for (;;) {
              while (queue.length) {
                yield { choices: [{ delta: { content: queue.shift() } }] };
              }
              if (ended) break;
              await new Promise(function (resolve) { wake = resolve; });
            }
            if (failed) throw failed;
            await running;
          })();
        }
      }
    }
  };
}
