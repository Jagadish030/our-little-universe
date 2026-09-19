// Supabase Edge Function: send-chat-push
//
// Triggered by a Database Webhook on chat_messages INSERT.
// Looks up the recipient's saved push subscription(s), sends them a
// system notification via the Web Push protocol, and marks the
// message as "delivered" (for the double-tick) once the push service
// has accepted it.

import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") || "mailto:example@example.com";
const SITE_URL = (Deno.env.get("SITE_URL") || "/").replace(/\/$/, "");

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

function letterToAuthor(letter: string) {
    return letter === "M" ? 2 : 1;
}

function messagePreview(record: Record<string, unknown>) {
    const type = record.content_type as string;
    if (type === "image") return "📷 Sent a photo";
    if (type === "voice") return "🎤 Sent a voice message";
    const text = (record.content_text as string) || "New message";
    return text.length > 120 ? text.slice(0, 117) + "…" : text;
}

Deno.serve(async (req) => {
    try {
        const payload = await req.json();
        const record = payload.record;
        if (!record || payload.table !== "chat_messages" || payload.type !== "INSERT") {
            return new Response("ignored", { status: 200 });
        }

        const recipientAuthor = letterToAuthor(record.recipient);
        const senderLetter = record.sender;

        const { data: subs, error } = await supabase
            .from("push_subscriptions")
            .select("*")
            .eq("author", recipientAuthor);

        if (error) throw error;
        if (!subs || subs.length === 0) {
            return new Response("no subscriptions", { status: 200 });
        }

        const notificationPayload = JSON.stringify({
            title: `${senderLetter} sent a message`,
            body: messagePreview(record),
            url: `${SITE_URL}/?open=chat`,
            scope: "chat",
            tag: "chat-message",
        });

        let anySuccess = false;

        await Promise.all(
            subs.map(async (sub) => {
                const pushSubscription = {
                    endpoint: sub.endpoint,
                    keys: { p256dh: sub.p256dh, auth: sub.auth },
                };
                try {
                    await webpush.sendNotification(pushSubscription, notificationPayload);
                    anySuccess = true;
                } catch (err: unknown) {
                    const statusCode = (err as { statusCode?: number })?.statusCode;
                    // 404/410 = the browser revoked or expired this
                    // subscription — clean it up so we stop trying.
                    if (statusCode === 404 || statusCode === 410) {
                        await supabase.from("push_subscriptions").delete().eq("id", sub.id);
                    } else {
                        console.error("Push failed:", err);
                    }
                }
            })
        );

        // The push service accepted the notification for delivery —
        // that's the closest thing to "it reached her device" we can
        // confirm from the server side, so this is what lights up the
        // (plain, uncolored) double tick. Being SEEN — the colored
        // double tick — stays a separate, client-side update for
        // whenever she actually opens the chat.
        if (anySuccess) {
            await supabase
                .from("chat_messages")
                .update({ delivered_at: new Date().toISOString() })
                .eq("id", record.id)
                .is("delivered_at", null);
        }

        return new Response("sent", { status: 200 });
    } catch (err) {
        console.error(err);
        return new Response("error", { status: 500 });
    }
});
