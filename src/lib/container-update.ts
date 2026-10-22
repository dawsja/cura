import { z } from 'zod';
import { env } from './env';
import { logger } from './logger';

const REGISTRY = 'https://ghcr.io';
const REPOSITORY = 'dawsja/cura';
const SUCCESS_TTL_MS = 30 * 60 * 1000;
const FAILURE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

const tokenResponseSchema = z
  .object({
    token: z.string().min(1).optional(),
    access_token: z.string().min(1).optional(),
  })
  .refine((value) => value.token || value.access_token, 'registry token missing');

const descriptorSchema = z.object({
  digest: z.string().min(1),
  platform: z
    .object({
      architecture: z.string(),
      os: z.string(),
    })
    .optional(),
});

const imageIndexSchema = z.object({
  manifests: z.array(descriptorSchema),
});

const imageManifestSchema = z.object({
  config: z.object({ digest: z.string().min(1) }),
});

const imageConfigSchema = z.object({
  config: z
    .object({
      Labels: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
});

export interface ContainerUpdateStatus {
  updateAvailable: boolean | null;
  currentRevision: string | null;
  latestRevision: string | null;
  checkedAt: string;
  reason?: 'build_revision_unavailable' | 'registry_unavailable';
}

interface CachedStatus {
  expiresAt: number;
  value: ContainerUpdateStatus;
}

let cached: CachedStatus | null = null;
let inFlight: Promise<ContainerUpdateStatus> | null = null;

function registryHeaders(token: string, accept?: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    'User-Agent': 'cura-update-check',
    ...(accept ? { Accept: accept } : {}),
  };
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`registry request failed with ${response.status}`);
  return response.json();
}

function registryArchitecture(): string | null {
  if (process.arch === 'x64') return 'amd64';
  if (process.arch === 'arm64') return 'arm64';
  return null;
}

async function latestImageRevision(): Promise<string> {
  const tokenUrl = new URL(`${REGISTRY}/token`);
  tokenUrl.searchParams.set('service', 'ghcr.io');
  tokenUrl.searchParams.set('scope', `repository:${REPOSITORY}:pull`);
  const tokenResponse = tokenResponseSchema.parse(await fetchJson(tokenUrl.toString()));
  const token = tokenResponse.token ?? tokenResponse.access_token;
  if (!token) throw new Error('registry token missing');

  const manifestAccept = [
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.v2+json',
  ].join(', ');
  const latestUrl = `${REGISTRY}/v2/${REPOSITORY}/manifests/latest`;
  const latest = await fetchJson(latestUrl, {
    headers: registryHeaders(token, manifestAccept),
  });

  let manifest: unknown = latest;
  const index = imageIndexSchema.safeParse(latest);
  if (index.success) {
    const architecture = registryArchitecture();
    const platform = index.data.manifests.find(
      (candidate) => candidate.platform?.os === 'linux' && candidate.platform.architecture === architecture,
    );
    if (!platform) throw new Error(`no registry manifest for linux/${architecture ?? process.arch}`);
    manifest = await fetchJson(`${REGISTRY}/v2/${REPOSITORY}/manifests/${platform.digest}`, {
      headers: registryHeaders(token, manifestAccept),
    });
  }

  const parsedManifest = imageManifestSchema.parse(manifest);
  const config = imageConfigSchema.parse(
    await fetchJson(`${REGISTRY}/v2/${REPOSITORY}/blobs/${parsedManifest.config.digest}`, {
      headers: registryHeaders(token),
    }),
  );
  const revision = config.config?.Labels?.['org.opencontainers.image.revision']?.trim();
  if (!revision) throw new Error('published image has no OCI revision label');
  return revision;
}

async function fetchContainerUpdateStatus(): Promise<ContainerUpdateStatus> {
  const checkedAt = new Date().toISOString();
  const currentRevision = env.APP_REVISION.trim();
  if (!currentRevision) {
    return {
      updateAvailable: null,
      currentRevision: null,
      latestRevision: null,
      checkedAt,
      reason: 'build_revision_unavailable',
    };
  }

  try {
    const latestRevision = await latestImageRevision();
    return {
      updateAvailable: latestRevision.toLowerCase() !== currentRevision.toLowerCase(),
      currentRevision,
      latestRevision,
      checkedAt,
    };
  } catch (err) {
    logger.warn({ err }, 'container update check failed');
    return {
      updateAvailable: null,
      currentRevision,
      latestRevision: null,
      checkedAt,
      reason: 'registry_unavailable',
    };
  }
}

export async function checkForContainerUpdate(force = false): Promise<ContainerUpdateStatus> {
  const now = Date.now();
  if (!force && cached && cached.expiresAt > now) return cached.value;
  if (inFlight) return inFlight;

  inFlight = fetchContainerUpdateStatus().then((value) => {
    cached = {
      value,
      expiresAt: Date.now() + (value.updateAvailable === null ? FAILURE_TTL_MS : SUCCESS_TTL_MS),
    };
    return value;
  });

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}
