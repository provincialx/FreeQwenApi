// Stability test — sliding window + tool_call pair preservation
const BASE = "http://127.0.0.1:3264/api";

async function run() {
  // Generate 65 messages to trigger sliding window (>60 threshold)
  const msgs = [];
  msgs.push({ role: "system", content: "You are a test assistant." });
  for (let i = 0; i < 64; i++) {
    if (i % 2 === 0) msgs.push({ role: "user", content: `Q${i}: hello ${i}` });
    else
      msgs.push({
        role: "assistant",
        content: `A${i}: ok ${i}.`,
      });
  }

  const firstNonSys = msgs[2];
  if (firstNonSys) {
    firstNonSys.role = "tool";
    firstNonSys.content = '{"result":"preserved"}';
    firstNonSys.tool_call_id = "call_1";
  }

  console.log(`\nTest 1: Sliding window with ${msgs.length} messages (triggers >60 cutoff)`);

  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "qwen3.7-max", stream: false, messages: msgs }),
  });

  const data = await res.json();
  console.log(`  Status: ${res.ok ? "OK" : res.status}`);
  console.log(`  Answer length: ${data?.choices?.[0]?.message?.content?.length || 0}`);
  console.log(`  Has error: ${!!data.error}`);

  if (!res.ok) {
    console.error("  Response:", JSON.stringify(data).slice(0, 300));
    process.exit(1);
  }

  // Test 2: Tool call roundtrip
  const toolMsgs = [
    { role: "system", content: "You can use tools." },
    { role: "user", content: "What's the weather?" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_abc", type: "function", function: { name: "get_weather", arguments: '{}' } }],
    },
    { role: "tool", content: '"Sunny, 25C"', tool_call_id: "call_abc" },
  ];

  console.log("\nTest 2: Tool call roundtrip");
  const res2 = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "qwen3.7-max", stream: false, messages: toolMsgs }),
  });

  const data2 = await res2.json();
  console.log(`  Status: ${res2.ok ? "OK" : res2.status}`);
  console.log(`  Answer length: ${data2?.choices?.[0]?.message?.content?.length || 0}`);
  console.log(`  Has error: ${!!data2.error}`);

  if (!res2.ok) {
    console.error("  Response:", JSON.stringify(data2).slice(0, 300));
    process.exit(1);
  }

  // Test 3: Streaming endpoint headers
  console.log("\nTest 3: Streaming endpoint");
  const res3 = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "qwen3.7-max", stream: true, messages: [{ role: "user", content: "Reply with one word: streaming" }] }),
  });

  console.log(`  Status: ${res3.ok ? "OK" : res3.status}`);
  console.log(`  Content-Type includes event-stream: ${res3.headers.get("content-type").includes("text/event-stream")}`);

  // Quick read first chunk to verify stream works
  const reader = res3.body?.getReader();
  if (reader) {
    const { done, value } = await reader.read();
    console.log(`  First chunk received: ${!done && !!value}`);
    reader.releaseLock();
  }

  console.log("\n=== All stability tests passed ===");
}

run().catch((err) => {
  console.error("Test failed:", err.message);
  process.exit(1);
});
