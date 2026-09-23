import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Syncs posts/*.md from this repo's own GitHub tree into `links` - the
// "publish a blog post" pipeline is just: add a Markdown file under
// posts/, push to main. GitHub's contents API is public/unauthenticated
// for a public repo, but does require a User-Agent header.
const REPO = "JungeWerther/seb.now";
const BRANCH = "main";
const SITE_URL = "https://seb.now";
const GITHUB_API_HEADERS = { "User-Agent": "seb-now-local-post-ingest" };

interface GithubContentEntry {
  name: string;
  download_url: string;
}

function parseFrontmatter(text: string): Record<string, string> {
  const lines = text.split("\n");
  const fields: Record<string, string> = {};
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") break;
      const idx = lines[i].indexOf(":");
      if (idx === -1) continue;
      fields[lines[i].slice(0, idx).trim()] = lines[i].slice(idx + 1).trim();
    }
  }
  return fields;
}

Deno.serve(async (_req: Request) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const results = [];

  try {
    const listRes = await fetch(
      `https://api.github.com/repos/${REPO}/contents/posts?ref=${BRANCH}`,
      { headers: GITHUB_API_HEADERS },
    );
    if (!listRes.ok) {
      return new Response(JSON.stringify({ error: `list ${listRes.status}` }, null, 2), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }
    const entries: GithubContentEntry[] = await listRes.json();
    const mdEntries = entries.filter((entry) => entry.name.endsWith(".md"));

    let upserted = 0;
    for (const entry of mdEntries) {
      try {
        const rawRes = await fetch(entry.download_url);
        if (!rawRes.ok) {
          results.push({ file: entry.name, error: `raw ${rawRes.status}` });
          continue;
        }
        const text = await rawRes.text();
        const fields = parseFrontmatter(text);
        const slug = fields.slug || entry.name.replace(/\.md$/, "");
        const title = fields.title || slug;

        const { error } = await supabase.from("links").upsert(
          {
            url: `${SITE_URL}/posts/${slug}/`,
            title,
            image_url: fields.image || null,
            origin: "local",
            submitted_by: null,
          },
          { onConflict: "url" },
        );
        if (error) {
          results.push({ file: entry.name, error: error.message });
        } else {
          upserted++;
        }
      } catch (e) {
        results.push({ file: entry.name, error: String(e) });
      }
    }

    return new Response(JSON.stringify({ fetched: mdEntries.length, upserted, results }, null, 2), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }, null, 2), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
