// Supabase Edge Function: send-activity-push
//
// Triggered by Database Webhooks on INSERT for: memories, love_notes,
// doodles, bucket_list, daily_moods, anger_log, and
// photobooth_duel_requests (Duo Snap invites). One shared function —
// it looks at payload.table to decide what happened, who should be
// notified, and which screen tapping the notification should open.

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

// Every table here identifies its author differently — some store a
// number (1/2), some a letter ('J'/'M'), some a numeric-looking
// string ('1'/'2'). This normalizes all of them down to 1 or 2.
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

// The field that identifies who triggered the row, per table — most
// use `author`, anger_log uses `who`, and the Duo Snap invite table
// uses `initiator`.
function senderFieldFor(table: string, record: Record<string, unknown>): unknown {
    if (table === "anger_log") return record.who;
    if (table === "photobooth_duel_requests") return record.initiator;
    return record.author;
}

// The scope name the FRONTEND uses to know which section to open —
// must match the scope keys already used by enterScope()/lastSeenFor()
// on the site (notes, doodles, mood, bucket, memories, fight,
// photobooth-duel).
function scopeFor(table: string): string | null {
    switch (table) {
        case "memories": return "memories";
        case "love_notes": return "notes";
        case "doodles": return "doodles";
        case "bucket_list": return "bucket";
        case "daily_moods": return "mood";
        case "anger_log": return "fight";
        case "photobooth_duel_requests": return "photobooth-duel";
        default: return null;
    }
}

// Builds the { title, body } for each table. Returns null for a
// table/row this function shouldn't notify about (e.g. it doesn't
// recognize it, or fields are missing).
function describeEvent(table: string, record: Record<string, unknown>) {
    const senderLetter = letterFor(authorNum(senderFieldFor(table, record)));

    switch (table) {
        case "memories":
            return { title: "New memory 📸", body: `${senderLetter} added a new photo` };
        case "love_notes": {
            const preview = (record.message as string) || "a new note";
            return {
                title: "Love note 💌",
                body: `${senderLetter}: ${preview.length > 100 ? preview.slice(0, 97) + "…" : preview}`,
            };
        }
        case "doodles":
            return { title: "New doodle 🎨", body: `${senderLetter} drew something for you` };
        case "bucket_list": {
            const item = (record.item as string) || "a new wish";
            return { title: "Bucket list 🌟", body: `${senderLetter} added: ${item.length > 100 ? item.slice(0, 97) + "…" : item}` };
        }
        case "daily_moods":
            return { title: "Mood calendar 🌤️", body: `${senderLetter} logged today's mood` };
        case "anger_log":
            return { title: "💔", body: `${senderLetter} is upset — check what's wrong` };
        case "photobooth_duel_requests": {
            if (record.status !== "pending") return null; // only the initial invite notifies
            return { title: "Duo Snap 📸", body: `${senderLetter} wants to take a Duo Snap with you` };
        }
        default:
            return null;
    }
}

function recipientAuthorNum(table: string, record: Record<string, unknown>) {
    const sender = authorNum(senderFieldFor(table, record));
    return otherAuthorNum(sender);
}

Deno.serve(async (req) => {
    try {
        const payload = await req.json();
        const record = payload.record;
        const table = payload.table;
        if (!record || payload.type !== "INSERT") {
            return new Response("ignored", { status: 200 });
        }

        const event = describeEvent(table, record);
        if (!event) return new Response("unrecognized table", { status: 200 });

        const recipient = recipientAuthorNum(table, record);
        const scope = scopeFor(table);

        const { data: subs, error } = await supabase
            .from("push_subscriptions")
            .select("*")
            .eq("author", recipient);

        if (error) throw error;
        if (!subs || subs.length === 0) return new Response("no subscriptions", { status: 200 });

        // Duo Snap invites need the round_id (not just the row id) so the
        // tapped notification can open straight into that specific
        // accept/decline screen.
        const extraParam = table === "photobooth_duel_requests" && record.round_id
            ? `&round=${encodeURIComponent(record.round_id as string)}`
            : "";

        const notificationPayload = JSON.stringify({
            title: event.title,
            body: event.body,
            url: `${SITE_URL}/?open=${scope}&id=${record.id}${extraParam}`,
            scope,
            id: record.id,
            roundId: table === "photobooth_duel_requests" ? record.round_id : undefined,
            tag: `activity-${table}`,
            alwaysShow: true,
        });

        await Promise.all(
            subs.map(async (sub) => {
                const pushSubscription = {
                    endpoint: sub.endpoint,
                    keys: { p256dh: sub.p256dh, auth: sub.auth },
                };
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

        return new Response("sent", { status: 200 });
    } catch (err) {
        console.error(err);
        return new Response("error", { status: 500 });
    }
});
