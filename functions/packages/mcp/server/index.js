// Proxies seb.now/mcp to the `mcp` Supabase Edge Function (a stateless
// Streamable HTTP MCP server), relaying method, body and status unchanged.
const MCP_FUNCTION_URL = "https://yoxrhqlzsqwfjmsjpari.supabase.co/functions/v1/mcp";
const FORWARDED_REQUEST_HEADERS = ["content-type", "accept", "mcp-protocol-version"];
const RELAYED_RESPONSE_HEADERS = [
  "allow",
  "access-control-allow-origin",
  "access-control-allow-methods",
  "access-control-allow-headers",
];

async function main(args) {
  const http = args.http || {};
  const method = (http.method || "POST").toUpperCase();
  let body = http.body || "";
  if (http.isBase64Encoded) {
    body = Buffer.from(body, "base64").toString("utf8");
  }

  const incomingHeaders = http.headers || {};
  const forwardHeaders = {};
  for (const name of FORWARDED_REQUEST_HEADERS) {
    if (incomingHeaders[name]) forwardHeaders[name] = incomingHeaders[name];
  }

  const res = await fetch(MCP_FUNCTION_URL, {
    method,
    headers: forwardHeaders,
    body: method === "POST" ? body : undefined,
  });
  const responseBody = await res.text();

  const headers = {};
  for (const name of RELAYED_RESPONSE_HEADERS) {
    const value = res.headers.get(name);
    if (value) headers[name] = value;
  }
  // DO's gateway rejects a JSON content type whose body isn't JSON, which an
  // empty 202/204 body isn't.
  headers["Content-Type"] = responseBody ? res.headers.get("content-type") || "application/json" : "text/plain";

  return { statusCode: res.status, headers, body: responseBody };
}

exports.main = main;
