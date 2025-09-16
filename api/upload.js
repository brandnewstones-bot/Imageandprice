// api/upload.js
// Minimal Vercel serverless function that commits image + json to GitHub using the REST API.
// No external npm packages required.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // change "*" to your domain for tighter security
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Upload-Secret, Authorization",
};

async function getFileSha(owner, repo, path, branch, githubToken) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`;
  const r = await fetch(url, {
    headers: { Authorization: `token ${githubToken}`, "User-Agent": "vercel-function" },
  });
  if (r.status === 200) {
    const j = await r.json();
    return j.sha;
  }
  return null;
}

async function putFile(owner, repo, path, branch, contentBase64, message, githubToken, sha = undefined) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
  const body = { message, content: contentBase64, branch };
  if (sha) body.sha = sha;
  const r = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `token ${githubToken}`,
      "User-Agent": "vercel-function",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) {
    const err = new Error("GitHub API error");
    err.details = j;
    throw err;
  }
  return j;
}

export default async function handler(req, res) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // Only POST allowed
  if (req.method !== "POST") {
    res.writeHead(405, { ...CORS_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  // Attach CORS headers to responses
  res.setHeader("Access-Control-Allow-Origin", CORS_HEADERS["Access-Control-Allow-Origin"]);

  try {
    // Simple secret-based protection (optional but better than open endpoint).
    // If you set UPLOAD_SECRET env var in Vercel, frontend must send it in header X-Upload-Secret.
    if (process.env.UPLOAD_SECRET) {
      const provided = req.headers["x-upload-secret"] || "";
      if (provided !== process.env.UPLOAD_SECRET) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: "Unauthorized (bad upload secret)" }));
        return;
      }
    }

    // Basic env validation
    const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    const GITHUB_REPO = process.env.GITHUB_REPO; // "owner/repo"
    const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
    if (!GITHUB_TOKEN || !GITHUB_REPO) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "Server misconfigured: set GITHUB_TOKEN and GITHUB_REPO" }));
      return;
    }
    const [owner, repo] = GITHUB_REPO.split("/");
    if (!owner || !repo) throw new Error("Invalid GITHUB_REPO");

    // Parse body (Vercel automatically parses JSON)
    const { productId, imageBase64, productData } = req.body || {};
    if (!productId || !productData) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Missing productId or productData" }));
      return;
    }

    // imageBase64 is optional but if present must be base64 without data: prefix
    if (imageBase64 && typeof imageBase64 !== "string") {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "imageBase64 must be base64 string" }));
      return;
    }

    // 1) Commit image (if provided)
    if (imageBase64) {
      const imagePath = `images/${productId}.jpg`;
      // Check if exists to get sha for updates
      const existingSha = await getFileSha(owner, repo, imagePath, GITHUB_BRANCH, GITHUB_TOKEN);
      await putFile(
        owner,
        repo,
        imagePath,
        GITHUB_BRANCH,
        imageBase64,
        `Add/update image for ${productId}`,
        GITHUB_TOKEN,
        existingSha || undefined
      );
    }

    // 2) Commit product JSON
    const jsonPath = `products/${productId}.json`;
    const jsonContent = Buffer.from(JSON.stringify(productData, null, 2)).toString("base64");
    const existingJsonSha = await getFileSha(owner, repo, jsonPath, GITHUB_BRANCH, GITHUB_TOKEN);
    const putResp = await putFile(
      owner,
      repo,
      jsonPath,
      GITHUB_BRANCH,
      jsonContent,
      `Add/update product data for ${productId}`,
      GITHUB_TOKEN,
      existingJsonSha || undefined
    );

    res.setHeader("Content-Type", "application/json");
    res.statusCode = 200;
    res.end(JSON.stringify({ success: true, result: putResp }));
  } catch (err) {
    console.error("upload error:", err);
    res.statusCode = 500;
    const message = err.details ? err.details : (err.message || "Upload failed");
    res.end(JSON.stringify({ error: "Upload failed", message }));
  }
}
