/** ローカルでゲートウェイを動かす（npm run gateway）。Vercel では src/index.ts を使う。 */
import { createGatewayApp } from './app.ts';

const { app, flush } = await createGatewayApp();
const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => console.log(`gateway listening on :${port}`));

// 終了時は書き込み中のログを待つ
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, async () => {
    await flush();
    process.exit(0);
  });
}
