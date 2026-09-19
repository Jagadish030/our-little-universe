// Supabase Edge Function: send-response-push
//
// Triggered by Database Webhooks on UPDATE for: memories, love_notes,
// doodles, and anger_log. Notifies the ORIGINAL author when their
// partner replies to or reacts on the thing they posted, and tells
// the frontend to open straight to that specific item's reply view.

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

function authorNum(value: unknown): number {
    if (value === 2 || value === "2" || value === "M") return 2;
    return 1;
}
function otherAuthorNum(n: number) {
    return n === 2 ? 1 : 2;
}
function letterFor(n: number) {
    return n === 2 ? "M" : "J";
}
// Same scope keys the frontend already uses for enterScope()/lastSeenFor().
function scopeFor(table: string): string {
    switch (table) {
        case "memories": return "memories";
        case "love_notes": return "notes";
        case "doodles": return "doodles";
        case "anger_log": return "fight";
        default: return table;
    }
}

type ResponseEvent = { recipient: number; title: string; body: string; tagSuffix: string };

function describeResponseEvents(
    table: string,
    record: Record<string, unknown>,
    oldRecord: Record<string, unknown>
): ResponseEvent[] {
    const events: ResponseEvent[] = [];

    if (table === "anger_log") {
        const recipient = authorNum(record.who);
        const senderLetter = letterFor(otherAuthorNum(recipient));
        const newCooldown =
            (record.cooldown_text && record.cooldown_text !== oldRecord.cooldown_text) ||
            (record.cooldown_audio_url && record.cooldown_audio_url !== oldRecord.cooldown_audio_url);
        if (newCooldown) {
            events.push({
                recipient,
                title: "💛",
                body: `${senderLetter} left something to cool you off`,
                tagSuffix: "cooldown",
            });
        }
        return events;
    }

    const itemLabel = table === "memories" ? "memory" : table === "love_notes" ? "note" : table === "doodles" ? "doodle" : null;
    if (!itemLabel) return events;

    const recipient = authorNum(record.author);
    const senderLetter = letterFor(otherAuthorNum(recipient));

    const newReply =
        (record.reply && record.reply !== oldRecord.reply) ||
        (record.reply_audio_url && record.reply_audio_url !== oldRecord.reply_audio_url);
    if (newReply) {
        events.push({
            recipient,
            title: "New reply 💬",
            body: `${senderLetter} replied to your ${itemLabel}`,
            tagSuffix: "reply",
        });
    }

    // memories doesn't have a reaction feature — only reply.
    if (table !== "memories") {
        const newReaction =
            (record.reaction && record.reaction !== oldRecord.reaction) ||
            (record.reaction_audio_url && record.reaction_audio_url !== oldRecord.reaction_audio_url);
        if (newReaction) {
            events.push({
                recipient,
                title: "New reaction ✨",
                body: `${senderLetter} reacted to your ${itemLabel}`,
                tagSuffix: "reaction",
            });
        }
    }

    return events;
}

async function sendToAuthor(recipient: number, title: string, body: string, tag: string, scope: string, id: unknown) {
    const { data: subs, error } = await supabase.from("push_subscriptions").select("*").eq("author", recipient);
    if (error) throw error;
    if (!subs || subs.length === 0) return;

    const notificationPayload = JSON.stringify({
        title,
        body,
        url: `${SITE_URL}/?open=${scope}&id=${id}&reply=1`,
        scope,
        id,
        reply: true,
        tag,
        alwaysShow: true,
    });

    await Promise.all(
        subs.map(async (sub) => {
            const pushSubscription = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
            try {
                await webpush.sendNotification(pushSubscription, notificationPayload);
            } catch (err: unknown) {
                const statusCode = (err as { statusCode?: number })?.statusCode;
                if (statusCode === 404 || statusCode === 410) {
                    await supabase.from("push_subscriptions").delete().eq("id", sub.id);
                } else {
                    console.error("Push failed:", err);
                }
            }
        })
    );
}

Deno.serve(async (req) => {
    try {
        const payload = await req.json();
        const { table, type, record, old_record } = payload;
        if (!record || !old_record || type !== "UPDATE") {
            return new Response("ignored", { status: 200 });
        }

        const scope = scopeFor(table);
        const events = describeResponseEvents(table, record, old_record);
        for (const ev of events) {
            await sendToAuthor(ev.recipient, ev.title, ev.body, `response-${table}-${ev.tagSuffix}-${record.id}`, scope, record.id);
        }

        return new Response("sent", { status: 200 });
    } catch (err) {
        console.error(err);
        return new Response("error", { status: 500 });
    }
});
