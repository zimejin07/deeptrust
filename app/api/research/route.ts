import { runResearch } from "@/lib/agent";
import { NextRequest } from "next/server";

export async function POST(req: NextRequest) {
    const { query } = await req.json();

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        async start(controller) {
            for await (const event of runResearch(query)) {
                controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
            }
            controller.close();
        }
    });

    return new Response(stream, {
        headers: { "Content-Type": "text/event-stream" }
    });
}