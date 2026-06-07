target = "src/api/routes.js"

with open(target, "r", encoding="utf-8") as f:
    content = f.read()

old_log = """    // Логируем полную историю сообщений
    logInfo(
      `История содержит ${messages.length} сообщений: ${messages.map((m) => m.role).join(", ")}`,
    );"""

new_log = """    // Сворачиваем историю, чтобы не превращать консоль в "потрошное месиво" при agent-loop (tool_calls)
    const counts = {}; messages.forEach(m => { if (m?.role) counts[m.role] = (counts[m.role] || 0) + 1; });
    logInfo(`История: ${messages.length} сообщений (${Object.entries(counts).map(([k, v]) => `${v}${v === 1 ? '' : 'x'} ${k}`).join(", ")})`);"""

content = content.replace(old_log, new_log)

with open(target, "w", encoding="utf-8") as f:
    f.write(content)
print("OK: logs compacted in routes.js")
