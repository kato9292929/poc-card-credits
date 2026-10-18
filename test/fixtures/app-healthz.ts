// test/app.test.ts から子プロセスで実行する（親の環境を引き継がずにアプリを組み立てるため）
import { createGatewayApp } from '../../src/gateway/app.ts';

const { app } = await createGatewayApp();
const s = app.listen(0, async () => {
  const base = `http://127.0.0.1:${(s.address() as any).port}`;
  const h = await fetch(`${base}/healthz`);
  const j = await fetch(`${base}/api/jin/series`);
  console.log(JSON.stringify({ h: h.status, body: await h.json(), j: j.status }));
  s.close();
});
