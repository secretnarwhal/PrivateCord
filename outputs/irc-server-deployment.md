# IRC Server Deployment — Handoff Brief

**Goal:** stand up an IRC server that a Discord client plugin connects to over a **secure WebSocket** (`wss://`), so that everyone running the plugin lands in one shared channel.

You do not need to know anything about the Discord side to do this work. Everything the client needs from you is listed in §1 and §10. Estimated effort: 1–2 hours for a working server, plus DNS/TLS propagation time.

---

## 1. The contract

The client is a browser-based IRC client. It runs inside Discord's renderer process, which is an ordinary Chromium page served from `https://discord.com`. That single fact drives every requirement below.

| Requirement | Value | Why it is non-negotiable |
|---|---|---|
| Transport | **WebSocket** | The client runs in a browser sandbox. It cannot open a raw TCP socket. A normal IRC port (6667/6697) is unreachable to it. |
| Scheme | **`wss://`** (TLS) | The page is served over HTTPS. Browsers block `ws://` from an HTTPS page as mixed content. Plain `ws://` works **only** for `localhost` testing. |
| Frame type | **Text** (UTF-8), not binary | The client reads `event.data` as a string and ignores anything else. |
| Subprotocol | `text.ircv3.net` | Requested during the handshake. If the server rejects it the client retries once with no subprotocol, so this is strongly preferred but not fatal. |
| Auth | **SASL PLAIN** (optional) | Used only if a user fills in account credentials. The server must not *require* SASL unless you intend to lock the room down (see §8). |

**Capabilities the client requests.** All are optional — it degrades gracefully if any are missing. Supporting them is free on Ergo and improves the experience:

`server-time` · `message-tags` · `multi-prefix` · `echo-message` · `account-notify` · `extended-join` · `away-notify` · `chghost` · `sasl`

> `echo-message` is the one worth confirming: with it, the server echoes the sender's own messages back, which is how the client avoids rendering duplicates.

---

## 2. Why Ergo

Use **[Ergo](https://ergo.chat)** (formerly Oragono). It is a single static Go binary with **native IRCv3 WebSocket support** and a built-in account/channel registration service — no separate NickServ/ChanServ, no Atheme, no services linkage.

The main alternative, UnrealIRCd, also supports WebSockets but needs more moving parts. Do not use Solanum/Charybdis/InspIRCd-without-modules: Solanum in particular has **no WebSocket support at all** (this is why Libera.Chat, which runs Solanum, was ruled out for this project — its webchat goes through a separate KiwiIRC gateway).

---

## 3. Prerequisites

- A small Linux VPS. 1 vCPU / 1 GB RAM is generous for a few hundred users.
- A DNS **A/AAAA record** pointing at it, e.g. `irc.example.com`.
- Ports **443** (or 8097) and **80** (for ACME HTTP-01 challenge) open.
- A TLS certificate for that hostname. Let's Encrypt is fine.

---

## 4. Install

```bash
ERGO_VERSION=2.16.0
curl -fsSL "https://github.com/ergochat/ergo/releases/download/v${ERGO_VERSION}/ergo-${ERGO_VERSION}-linux-x86_64.tar.gz" -o ergo.tar.gz
```

Verify the checksum against the release page before extracting, then:

```bash
sudo useradd --system --home /var/lib/ergo --create-home ergo
sudo tar -xzf ergo.tar.gz --strip-components=1 -C /usr/local/bin ergo-*/ergo
sudo mkdir -p /etc/ergo
```

Copy `default.yaml` from the tarball to `/etc/ergo/ircd.yaml` as your starting point — it is heavily commented and worth reading rather than replacing wholesale.

---

## 5. TLS: pick one of two approaches

### Option A — Ergo terminates TLS directly (recommended)

Fewer moving parts, and Ergo sees real client IPs without any extra configuration.

Issue a certificate with certbot in standalone mode, then grant the `ergo` user read access to the key. You will need a renewal hook that re-copies the certs and reloads Ergo (`ergo rehash`, or `systemctl reload ergo`), because certbot's output is root-owned by default.

### Option B — Caddy or nginx reverse-proxies to Ergo

Choose this if the host already serves other sites on 443. Caddy handles certificate issuance and renewal automatically:

```
irc.example.com {
    reverse_proxy /webirc 127.0.0.1:8097
}
```

If you do this, you **must** set `proxy: true` on the Ergo listener and configure the proxy to send the real client IP — otherwise every user appears to connect from `127.0.0.1`, which silently defeats all the per-IP rate limiting in §7.

---

## 6. Core configuration

Edit `/etc/ergo/ircd.yaml`. The blocks below are the ones that matter for this deployment; leave the rest of `default.yaml` as shipped.

```yaml
network:
    name: PrivateCord

server:
    name: irc.example.com

    listeners:
        # Standard TLS IRC, for normal desktop clients (irssi, weechat, HexChat).
        # Not used by the Discord plugin, but invaluable for debugging — it lets
        # you test the server independently of the plugin.
        ":6697":
            tls:
                cert: /etc/ergo/tls/fullchain.pem
                key:  /etc/ergo/tls/privkey.pem
            min-tls-version: 1.2

        # The listener the plugin actually uses.
        # Use ":443" if nothing else on the box needs that port — some corporate
        # and mobile networks block everything else outbound.
        ":8097":
            websocket: true
            tls:
                cert: /etc/ergo/tls/fullchain.pem
                key:  /etc/ergo/tls/privkey.pem
            min-tls-version: 1.2

    websockets:
        # An empty list means NO restriction — any website could have a visitor's
        # browser open a connection here. Pin it to Discord's origins.
        #
        # Bring the server up with this commented out first and confirm the
        # plugin connects; only then tighten it. If a user reports "connects on
        # desktop but not in the browser build", this is the first thing to check.
        allowed-origins:
            - "https://discord.com"
            - "https://canary.discord.com"
            - "https://ptb.discord.com"

    casemapping: precis
    enforce-utf8: true

    ip-cloaking:
        enabled: true
        netname: privatecord

limits:
    nicklen: 32
    channellen: 64
```

> **`nicklen: 32`** — the client sanitizes Discord usernames into legal IRC nicks and caps them at 30 characters, so anything ≥ 30 avoids surprise truncation.

Validate before restarting. This catches YAML mistakes without taking the server down:

```bash
ergo mkcerts --conf /etc/ergo/ircd.yaml && ergo run --conf /etc/ergo/ircd.yaml --smoke
```

---

## 7. Abuse hardening

This is the part that matters most, because the room is open to anyone with the plugin.

```yaml
server:
    ip-limits:
        count: true
        max-concurrent-connections: 8
        throttle: true
        window: 10m
        max-connections-per-window: 24
        cidr-len-ipv4: 32
        cidr-len-ipv6: 64
        exempted:
            - "localhost"

    max-sendq: 96k
```

Notes on tuning:

- **The client already rate-limits itself** — outbound messages go through a token bucket (burst of 5, then roughly one per 1.2 s). Ergo's defaults will not fight normal use.
- **The client reconnects with jittered exponential backoff** (1 s → 60 s). A server restart will not produce a synchronized reconnect stampede, so you do not need to over-provision `max-connections-per-window` for that case.
- `cidr-len-ipv6: 64` groups a whole residential IPv6 prefix as one "IP". Without it, a single user with a /64 trivially evades the concurrent-connection limit.
- Keep `ip-cloaking` on. It hides users' real IPs from each other in `WHOIS`, which they will reasonably expect.

---

## 8. Accounts and the channel

```yaml
accounts:
    registration:
        enabled: true
        allow-before-connect: true
        throttling:
            enabled: true
            duration: 10m
            max-attempts: 5

    require-sasl:
        enabled: false

    multiclient:
        enabled: true
        allowed-by-default: true

channels:
    default-modes: +ntC
    registration:
        enabled: true
        operator-only: false
```

Then create and register the channel from a normal IRC client connected on 6697:

```
/msg NickServ REGISTER <password>
/join #privatecord
/msg ChanServ REGISTER #privatecord
/mode #privatecord +ntC
/msg ChanServ AMODE #privatecord +o <your-account>
```

Mode reference: `+n` blocks external messages, `+t` restricts topic changes to ops, `+C` blocks CTCP (the client ignores CTCP anyway, and this stops a class of nuisance).

### Deciding how locked down the room should be

| Posture | Configuration | Trade-off |
|---|---|---|
| **Open** (default) | As above | Anyone with the plugin joins instantly. **Anyone can also claim any nickname, including yours** — there is no identity without SASL. |
| **Key-protected** | `/mode #privatecord +k <key>` | Users must enter the key in plugin settings. Simple, but the key spreads and cannot be revoked per-user. |
| **Account-required** | `/mode #privatecord +R`, or `require-sasl.enabled: true` | Everyone must register a nick. Real accountability and real nick ownership, at the cost of a signup step. **Choose this if impersonation matters.** |

Confirm the intended posture with whoever commissioned this before going live — it is the one decision here that is awkward to reverse once people have joined.

---

## 9. Service, monitoring, backups

Run under systemd as the `ergo` user with `Restart=on-failure`, and harden the unit with `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, and a `ReadWritePaths` entry for the data directory.

- **State** lives in a single BoltDB file (`ircd.db`) holding all account and channel registrations. Back it up. Use `ergo importdb`/`exportdb` rather than copying the file while the server is running.
- **Logs** — set the `logging` section to `level: info`. Be deliberate here: do **not** enable debug logging of message contents on a server people believe is private, and tell users what you do log.
- **Certificate renewal** is the most common cause of a silent outage. Verify the renewal hook actually reloads Ergo, and alert on cert expiry.

---

## 10. Acceptance tests

Run these in order. Each isolates a different failure mode.

1. **Plain IRC works.** Connect with `weechat`/`irssi` to `irc.example.com:6697` over TLS, join `#privatecord`, send a message. *Fails here → base config or TLS problem, nothing to do with WebSockets.*
2. **WebSocket endpoint accepts a connection.**
   ```bash
   websocat --protocol text.ircv3.net wss://irc.example.com:8097/
   ```
   Then type `NICK test`, `USER test 0 * :test`. You should get a `001` welcome numeric back. *Fails here → listener, TLS, or subprotocol problem.*
3. **Origin policy is right.** Repeat test 2 with `-H 'Origin: https://discord.com'`. *Fails only here → `allowed-origins` is wrong.*
4. **Both transports share one room.** With the `weechat` session from test 1 still joined, send a message from the WebSocket session and confirm it arrives.
5. **SASL works.** Authenticate with `AUTHENTICATE PLAIN` using a registered account.
6. **Rate limits do not fire during normal use.** Send ~10 messages over 30 seconds and confirm no throttle or disconnect.
7. **Restart is clean.** `systemctl restart ergo`, confirm clients reconnect on their own.

---

## 11. Hand back to the client developer

- `wss://` URL, including port and path — e.g. `wss://irc.example.com:8097/`
- Channel name, and the key if you set `+k`
- Whether SASL is optional or required
- Whether `echo-message` is enabled
- Nick length limit, if not 32
- Who to contact for moderation, and how to reach an operator

## Open questions for the commissioner

1. **Room posture** (§8) — open, key-protected, or account-required?
2. **Port 443 or 8097?** 443 traverses restrictive networks; 8097 keeps 443 free for other sites on the box.
3. **Logging and retention** — what, if anything, should be persisted, and are users told?
4. **Moderation** — who holds operator privileges, and what is the process for bans?
