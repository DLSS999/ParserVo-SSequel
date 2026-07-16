import type { SourceMediaItem } from "./media.server";

type AdminClient = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

type UserError = {
  field?: string[] | string | null;
  message: string;
};

type StagedTarget = {
  url: string;
  resourceUrl: string;
  parameters: Array<{ name: string; value: string }>;
};

function safeFilename(value: string) {
  const clean = String(value || "video")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 150);
  return clean || "product-video";
}

function extensionFor(mime: string) {
  if (/webm/i.test(mime)) return "webm";
  if (/quicktime/i.test(mime)) return "mov";
  return "mp4";
}

function ensureVideoMime(value: string) {
  const mime = String(value || "video/mp4").split(";")[0].toLowerCase();
  if (!/^video\/(mp4|webm|quicktime)$/.test(mime)) {
    throw new Error(`Unsupported Shopify video MIME type: ${mime}`);
  }
  return mime;
}

async function graphql<T>(
  admin: AdminClient,
  query: string,
  variables: Record<string, unknown>,
) {
  const response = await admin.graphql(query, { variables });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(`Shopify staged video HTTP ${response.status}: ${JSON.stringify(json).slice(0, 500)}`);
  }
  if (json.errors?.length) {
    throw new Error(json.errors.map((error: { message?: string }) => error.message || "GraphQL error").join(" | "));
  }
  return json.data as T;
}

export async function stageVideoForProductSet(input: {
  admin: AdminClient;
  video: SourceMediaItem;
  handle: string;
  position?: number;
}) {
  const sourceResponse = await fetch(input.video.url, {
    cache: "no-store",
    redirect: "follow",
  });
  if (!sourceResponse.ok) {
    throw new Error(`Could not read mirrored video: HTTP ${sourceResponse.status}`);
  }

  const bytes = await sourceResponse.arrayBuffer();
  if (!bytes.byteLength) throw new Error("Mirrored video is empty.");
  if (bytes.byteLength > 50 * 1024 * 1024) {
    throw new Error("Video exceeds the 50 MB ParserVo limit.");
  }

  const mime = ensureVideoMime(sourceResponse.headers.get("content-type") || "video/mp4");
  const filename = `${safeFilename(input.handle)}-video-${Math.max(1, Number(input.position || 1))}.${extensionFor(mime)}`;

  const stagedData = await graphql<{
    stagedUploadsCreate: {
      stagedTargets: StagedTarget[];
      userErrors: UserError[];
    };
  }>(
    input.admin,
    `#graphql
      mutation ParserVoStageVideo($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets {
            url
            resourceUrl
            parameters { name value }
          }
          userErrors { field message }
        }
      }
    `,
    {
      input: [{
        filename,
        mimeType: mime,
        fileSize: String(bytes.byteLength),
        resource: "VIDEO",
      }],
    },
  );

  const errors = stagedData.stagedUploadsCreate.userErrors || [];
  if (errors.length) {
    throw new Error(`Shopify staged video failed: ${errors.map((error) => error.message).join(" | ")}`);
  }

  const target = stagedData.stagedUploadsCreate.stagedTargets?.[0];
  if (!target?.url || !target.resourceUrl) {
    throw new Error("Shopify did not return a staged video upload target.");
  }

  const form = new FormData();
  for (const parameter of target.parameters || []) {
    form.append(parameter.name, parameter.value);
  }
  form.append("file", new Blob([bytes], { type: mime }), filename);

  const uploadResponse = await fetch(target.url, {
    method: "POST",
    body: form,
  });
  if (!uploadResponse.ok) {
    const body = await uploadResponse.text();
    throw new Error(`Shopify staged video upload HTTP ${uploadResponse.status}: ${body.slice(0, 500)}`);
  }

  return {
    originalSource: target.resourceUrl,
    alt: input.video.alt || null,
    contentType: "VIDEO",
  };
}
