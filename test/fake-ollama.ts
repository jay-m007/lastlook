// A stand-in for Ollama. Answers /api/chat from a queue, can be told to stall, and records
// everything it was sent so tests can check what the model was allowed to see.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface Fake {
  host: string;
  /** Objects returned in order. A number means "stall this many ms, then answer {}". */
  replies: (object | string | number)[];
  requests: { model: string; messages: { role: string; content: string }[]; format?: unknown; options?: unknown }[];
  close: () => Promise<void>;
  /** Set to a status code to make every call fail. */
  fail: number | null;
}

export async function startFake(): Promise<Fake> {
  const fake: Partial<Fake> = { replies: [], requests: [], fail: null };
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (req.url !== "/api/chat") { res.statusCode = 404; res.end("{}"); return; }
    fake.requests!.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (fake.fail) { res.statusCode = fake.fail; res.end(JSON.stringify({ error: "nope" })); return; }
    const next = fake.replies!.shift() ?? {};
    const send = (body: object | string) => res.end(JSON.stringify({ message: { role: "assistant", content: typeof body === "string" ? body : JSON.stringify(body) } }));
    if (typeof next === "number") { setTimeout(() => send({}), next); return; }
    send(next);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  fake.host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise((r) => server.close(() => r()));
  return fake as Fake;
}
