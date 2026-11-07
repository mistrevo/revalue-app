// recorder.mjs へ操作を送る。使い方: node video/demo/rc.mjs <操作> [引数...]
const PORT = Number(process.env.RECORDER_PORT ?? 5198);
const [cmd, ...args] = process.argv.slice(2);
const r = await fetch(`http://127.0.0.1:${PORT}/`, { method: 'POST', body: JSON.stringify({ cmd, args }) });
console.log(await r.text());
