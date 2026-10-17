/**
 * Vercel のエントリ（Express のゼロ設定デプロイ。default export のアプリを1つの関数として動かす）。
 * Vercel はこのファイルが express を import していることでエントリと判定するので、import を残すこと。
 * ログの書き込みは waitUntil で応答後も続ける（src/gateway/app.ts）。
 */
import type express from 'express';
import { createGatewayApp } from './gateway/app.ts';

const { app }: { app: express.Express } = await createGatewayApp();
export default app;
