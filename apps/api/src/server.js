import http from 'node:http';
import { requestHandler } from './app.js';

// Render and most container hosts require binding to all interfaces.
const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 3000);

const server = http.createServer(requestHandler);

server.listen(port, host, () => {
  console.log(`SwiftServe API listening on ${host}:${port}`);
});
