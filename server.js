import express from 'express';
import { Buffer } from 'buffer';

const app = express();
const port = process.env.PORT || 8080;

// Fly.io automatically sets FLY_APP_NAME
const appName = process.env.FLY_APP_NAME;
const WORKER_URL = process.env.WORKER_URL || (appName ? `${appName}.fly.dev` : "myworker.fly.dev");
const DEFAULT_UPSTREAM_TIMEOUT_MS = 25000;

// Increase limit if you expect large base64 payloads
app.use(express.json({ limit: '10mb' })); 

app.get('/', (req, res) => {
    return res.status(200).json({ e: "Relay is Active." });
});

app.post('/', async (req, res) => {
    try {
        const hop = req.headers["x-relay-hop"];
        const fwdHop = req.headers["x-fwd-hop"];
        if (hop === "1" || fwdHop === "1") {
            return res.status(508).json({ e: "loop detected" });
        }

        const payload = req.body;

        if (!payload || !payload.u) {
            return res.status(400).json({ e: "missing url" });
        }

        const targetUrl = new URL(payload.u);

        const BLOCKED_HOSTS = [
            WORKER_URL,
        ];

        if (BLOCKED_HOSTS.some(h => targetUrl.hostname.endsWith(h))) {
            return res.status(400).json({ e: "self-fetch blocked" });
        }

        const upstreamUrl = process.env.UPSTREAM_FORWARDER_URL || "";
        const wantForward = (payload.f === 1) || (payload.f === undefined);

        if (upstreamUrl && wantForward) {
            const upstreamResp = await forwardViaUpstream(payload, upstreamUrl);
            if (upstreamResp) {
                return res.status(upstreamResp.status)
                          .set(upstreamResp.headers)
                          .send(upstreamResp.body);
            }
            // fall through to direct fetch only when fail-mode is open
        }

        const fetchHeaders = new Headers();
        if (payload.h && typeof payload.h === "object") {
            for (const [k, v] of Object.entries(payload.h)) {
                fetchHeaders.set(k, v);
            }
        }

        fetchHeaders.set("x-relay-hop", "1");

        const fetchOptions = {
            method: (payload.m || "GET").toUpperCase(),
            headers: fetchHeaders,
            redirect: payload.r === false ? "manual" : "follow"
        };

        if (payload.b) {
            // Node.js Buffer makes decoding base64 trivial
            fetchOptions.body = Buffer.from(payload.b, 'base64');
        }

        const resp = await fetch(targetUrl.toString(), fetchOptions);

        // Node.js Buffer makes converting ArrayBuffer to base64 trivial and prevents stack overflows
        const arrayBuffer = await resp.arrayBuffer();
        const base64 = Buffer.from(arrayBuffer).toString('base64');

        const responseHeaders = {};
        resp.headers.forEach((v, k) => {
            responseHeaders[k] = v;
        });

        return res.status(200).json({
            s: resp.status,
            h: responseHeaders,
            b: base64
        });

    } catch (err) {
        return res.status(500).json({ e: String(err) });
    }
});

// Handle all other methods
app.all('/', (req, res) => {
    if (req.method !== 'GET' && req.method !== 'POST') {
        return res.status(405).json({ e: "Method not allowed." });
    }
});

async function forwardViaUpstream(payload, upstreamUrl) {
    const failMode = (process.env.UPSTREAM_FAIL_MODE || "closed").toLowerCase();
    const timeoutMs = parseInt(process.env.UPSTREAM_TIMEOUT_MS, 10) || DEFAULT_UPSTREAM_TIMEOUT_MS;
    const authKey = process.env.UPSTREAM_AUTH_KEY || "";

    let parsed;
    try {
        parsed = new URL(upstreamUrl);
    } catch (_) {
        return upstreamFailure("invalid UPSTREAM_FORWARDER_URL", failMode);
    }
    if (parsed.protocol !== "https:") {
        return upstreamFailure("UPSTREAM_FORWARDER_URL must be https://", failMode);
    }
    if (parsed.hostname.endsWith(WORKER_URL)) {
        return upstreamFailure("self-forward blocked", failMode);
    }
    if (!authKey) {
        return upstreamFailure("UPSTREAM_AUTH_KEY missing", failMode);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const resp = await fetch(upstreamUrl, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-upstream-auth": authKey
            },
            body: JSON.stringify(payload),
            signal: controller.signal
        });

        if (!resp.ok) {
            return upstreamFailure("forwarder status " + resp.status, failMode);
        }

        const body = await resp.text();
        return {
            status: 200,
            headers: { "content-type": "application/json" },
            body: body
        };
    } catch (err) {
        return upstreamFailure(String(err && err.message || err), failMode);
    } finally {
        clearTimeout(timer);
    }
}

function upstreamFailure(reason, failMode) {
    if (failMode === "open") {
        console.warn("upstream forwarder failed (falling back to direct):", reason);
        return null; // signals caller to fall through to direct fetch
    }
    return {
        status: 502,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ e: "upstream forwarder failed: " + reason })
    };
}

app.listen(port, '0.0.0.0', () => {
    console.log(`Relay listening on port ${port}`);
});
