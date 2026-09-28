addEventListener("fetch", event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  // Only allow requests from your own site — this is the fix.
  // Previously this was "*", meaning ANY website could call this endpoint
  // and use your API key. Now only these two origins are permitted.
  const allowedOrigins = ["https://thedollarbook.com", "https://www.thedollarbook.com"];
  const requestOrigin = request.headers.get("Origin");
  const originToAllow = allowedOrigins.includes(requestOrigin) ? requestOrigin : "";

  const cors = {
    "Access-Control-Allow-Origin": originToAllow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: cors });
  }

  // Reject anything that isn't from an allowed origin, before doing any work
  if (!originToAllow) {
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" }
    });
  }

  let body;
  try {
    body = await request.json();
  } catch(e) {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      headers: { ...cors, "Content-Type": "application/json" }
    });
  }

  const action = body.action || "ask";

  // ── ACTION: VERIFY ADMIN PASSWORD ──────────────────────
  // The password itself lives only here, as the ADMIN_PASSWORD secret —
  // never in the site's HTML/JS, so visitors can't read it via View Source.
  // Only a true/false result is ever sent back to the browser.
  if (action === "verify-admin") {
    const submitted = body.password || "";
    const correct = submitted === ADMIN_PASSWORD;
    return new Response(JSON.stringify({ ok: correct }), {
      headers: { ...cors, "Content-Type": "application/json" }
    });
  }

  // ── ACTION: GET ELON STOCK PRICES ─────────────────────
  if (action === "elon" || action === "tsla") {
    try {
      // Fetch Tesla and SpaceX prices simultaneously
      const [tslaRes, spcxRes] = await Promise.all([
        fetch("https://query1.finance.yahoo.com/v8/finance/chart/TSLA?interval=1d&range=1d", { headers: { "User-Agent": "Mozilla/5.0" } }),
        fetch("https://query1.finance.yahoo.com/v8/finance/chart/SPCX?interval=1d&range=1d", { headers: { "User-Agent": "Mozilla/5.0" } })
      ]);
      const tslaData = await tslaRes.json();
      const spcxData = await spcxRes.json();
      const tsla = tslaData?.chart?.result?.[0]?.meta?.regularMarketPrice || 0;
      const spcx = spcxData?.chart?.result?.[0]?.meta?.regularMarketPrice || 0;
      return new Response(JSON.stringify({ tsla: tsla, spcx: spcx, price: tsla }), {
        headers: { ...cors, "Content-Type": "application/json" }
      });
    } catch(e) {
      return new Response(JSON.stringify({ tsla: 0, spcx: 0, price: 0, error: e.message }), {
        headers: { ...cors, "Content-Type": "application/json" }
      });
    }
  }

  // ── ACTION: GET LIVE WEALTH STOCK PRICES (Musk, Bezos, Zuckerberg) ────
  // Separate from the "elon" action above (which is left untouched for
  // safety) so the existing Musk live-price feature can never be affected
  // by this addition. Fetches all four tickers needed for the three
  // stock-tied billionaires currently tracked live.
  if (action === "livewealth") {
    try {
      const tickers = ["TSLA", "SPCX", "AMZN", "META"];
      const responses = await Promise.all(
        tickers.map(t => fetch(
          "https://query1.finance.yahoo.com/v8/finance/chart/" + t + "?interval=1d&range=1d",
          { headers: { "User-Agent": "Mozilla/5.0" } }
        ))
      );
      const jsonResults = await Promise.all(responses.map(r => r.json()));
      const prices = {};
      tickers.forEach((t, i) => {
        prices[t.toLowerCase()] = jsonResults[i]?.chart?.result?.[0]?.meta?.regularMarketPrice || 0;
      });
      return new Response(JSON.stringify(prices), {
        headers: { ...cors, "Content-Type": "application/json" }
      });
    } catch(e) {
      return new Response(JSON.stringify({ tsla: 0, spcx: 0, amzn: 0, meta: 0, error: e.message }), {
        headers: { ...cors, "Content-Type": "application/json" }
      });
    }
  }

  // ── ACTION: ADD PERSON TO DOLLAR BOOK ──────────────────
  // Publishes a permanent entry that every visitor will see, so it requires
  // the admin password. Previously any visitor could trigger this via the
  // bot's "Add to The Dollar Book" button. The browser handles a refusal
  // gracefully by adding the person for that visitor's session only.
  if (action === "add") {
    try {
      if ((body.password || "") !== ADMIN_PASSWORD) {
        return new Response(JSON.stringify({
          success: false,
          message: "Only the site owner can add people permanently"
        }), { headers: { ...cors, "Content-Type": "application/json" } });
      }

      // Basic input limits so a single entry can't bloat or poison the file
      const name = String(body.name || "").trim().slice(0, 100);
      const wealth = Number.isFinite(Number(body.wealth)) ? Number(body.wealth) : 0;
      const note = String(body.note || "").slice(0, 300);
      const rawUrl = String(body.url || "").trim().slice(0, 300);
      const url = rawUrl.startsWith("https://") ? rawUrl : "";
      const key = name.toLowerCase();
      if (!key) {
        return new Response(JSON.stringify({ success: false, message: "Name is required" }), {
          headers: { ...cors, "Content-Type": "application/json" }
        });
      }

      const getRes = await fetch(
        "https://api.github.com/repos/thedotbook/thedotbook/contents/custom.json",
        {
          headers: {
            "Authorization": "token " + GITHUB_TOKEN,
            "Accept": "application/vnd.github.v3+json",
            "User-Agent": "DollarBook-Worker",
          },
        }
      );

      const getJson = await getRes.json();
      // GitHub returns the file as base64 of UTF-8 bytes. Decode it as
      // UTF-8 properly - plain atob() alone treats each byte as a separate
      // character, so every save used to re-encode characters like "·" one
      // more time, snowballing into thousands of garbage characters.
      const bytes = Uint8Array.from(atob(getJson.content.replace(/\s/g, "")), c => c.charCodeAt(0));
      const currentContent = JSON.parse(new TextDecoder("utf-8").decode(bytes));
      const sha = getJson.sha;

      if (!currentContent.adds) currentContent.adds = {};
      currentContent.adds[key] = { wealth: wealth, note: note, url: url };

      const newContent = btoa(unescape(encodeURIComponent(JSON.stringify(currentContent, null, 2))));

      const putRes = await fetch(
        "https://api.github.com/repos/thedotbook/thedotbook/contents/custom.json",
        {
          method: "PUT",
          headers: {
            "Authorization": "token " + GITHUB_TOKEN,
            "Accept": "application/vnd.github.v3+json",
            "Content-Type": "application/json",
            "User-Agent": "DollarBook-Worker",
          },
          body: JSON.stringify({
            message: "Add " + name + " via Dollar Book AI",
            content: newContent,
            sha: sha,
          }),
        }
      );

      if (putRes.ok) {
        return new Response(JSON.stringify({ success: true, message: name + " added!" }), {
          headers: { ...cors, "Content-Type": "application/json" }
        });
      } else {
        const err = await putRes.json();
        return new Response(JSON.stringify({ success: false, message: err.message || "GitHub error" }), {
          headers: { ...cors, "Content-Type": "application/json" }
        });
      }
    } catch(e) {
      return new Response(JSON.stringify({ success: false, message: e.message }), {
        headers: { ...cors, "Content-Type": "application/json" }
      });
    }
  }

  // ── ACTION: ASK CLAUDE ─────────────────────────────────
  const question = body.question || "";
  const context = body.context || "";

  let wikiContext = "";
  let wikiWealth = 0;
  try {
    const match = context.match(/looking at ([^(]+)/);
    const entityName = match ? match[1].trim() : "";
    if (entityName) {
      const wikiRes = await fetch(
        "https://en.wikipedia.org/api/rest_v1/page/summary/" +
        encodeURIComponent(entityName.replace(/ /g, "_"))
      );
      if (wikiRes.ok) {
        const wikiData = await wikiRes.json();
        if (wikiData.extract) {
          wikiContext = "Wikipedia says: " + wikiData.extract.slice(0, 800) + " ";
          const extract = wikiData.extract;
          let wm = extract.match(/net worth[^$]*\$?([\d,.]+)\s*billion/i);
          if (wm) wikiWealth = Math.round(parseFloat(wm[1].replace(/,/g,"")) * 1000);
          if (!wikiWealth) {
            wm = extract.match(/net worth[^$]*\$?([\d,.]+)\s*million/i);
            if (wm) wikiWealth = Math.round(parseFloat(wm[1].replace(/,/g,"")));
          }
        }
      }
    }
  } catch(e) {}

  const apiResponse = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CLAUDE_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      system: "You are The Dollar Book AI assistant. Every $ sign = $1 million. Only answer questions about wealth, net worth, and people/companies/countries in The Dollar Book. If a question is unrelated to these topics, politely decline and redirect the user back to asking about wealth or The Dollar Book. When asked to find someone for The Dollar Book always respond in this EXACT format: NAME | WORTH_IN_MILLIONS | CATEGORY | NATIONALITY | WIKIPEDIA_URL | DESCRIPTION. Use numbers only for worth. For living people use net worth in millions. For historical figures use inflation-adjusted wealth. NEVER return 0 — always estimate. Categories: Music, Film & TV, Sport, Tech & Business, Historical, Royalty & Politics.",
      messages: [
        {
          role: "user",
          content: wikiContext + context + " " + question,
        },
      ],
    }),
  });

  const data = await apiResponse.json();
  let text = data.content[0].text;

  if (wikiWealth > 0 && text.includes("|")) {
    const parts = text.split("|").map(p => p.trim());
    if (parts.length >= 2 && parseInt(parts[1]) === 0) {
      parts[1] = String(wikiWealth);
      text = parts.join(" | ");
    }
  }

  return new Response(JSON.stringify({ text: text, wikiWealth: wikiWealth }), {
    headers: { ...cors, "Content-Type": "application/json" }
  });
}
