import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { DatabaseService } from '../../models/database';
import { createTestApp } from '../helpers/app-factory';
import { createAdminAndToken } from '../helpers/auth-helpers';
import { MOCK_PIN, MOCK_AUTH_RESPONSE, MOCK_USER_SERVERS, MOCK_SERVER_IDENTITY } from '../helpers/plex-fixtures';

// Mock plexService
vi.mock('../../services/plexService', () => {
  const generatePin = vi.fn();
  const checkPin = vi.fn();
  const getUserServers = vi.fn();
  const findBestServerConnection = vi.fn();
  const getServerIdentity = vi.fn();
  const setServerConnection = vi.fn();
  const testConnection = vi.fn();
  const testConnectionWithCredentials = vi.fn();
  const getLibraries = vi.fn();
  const getLibraryContent = vi.fn();
  const getMediaMetadata = vi.fn();
  const getSeasons = vi.fn();
  const getEpisodes = vi.fn();
  const getTracks = vi.fn();
  const search = vi.fn();
  const getRecentlyAdded = vi.fn();
  const getDownloadUrl = vi.fn();
  const getDirectDownloadUrl = vi.fn();
  const getThumbnailUrl = vi.fn();

  return {
    plexService: {
      generatePin,
      checkPin,
      getUserServers,
      findBestServerConnection,
      getServerIdentity,
      setServerConnection,
      testConnection,
      testConnectionWithCredentials,
      getLibraries,
      getLibraryContent,
      getMediaMetadata,
      getSeasons,
      getEpisodes,
      getTracks,
      search,
      getRecentlyAdded,
      getDownloadUrl,
      getDirectDownloadUrl,
      getThumbnailUrl,
    },
    getAvailableResolutions: vi.fn().mockReturnValue([]),
    RESOLUTION_PRESETS: [
      { id: '1080p', label: '1080p', height: 1080, width: 1920, maxVideoBitrate: 8000, videoCodec: 'h264', audioCodec: 'aac', container: 'mp4' },
      { id: '720p', label: '720p', height: 720, width: 1280, maxVideoBitrate: 4000, videoCodec: 'h264', audioCodec: 'aac', container: 'mp4' },
      { id: '480p', label: '480p', height: 480, width: 854, maxVideoBitrate: 2000, videoCodec: 'h264', audioCodec: 'aac', container: 'mp4' },
    ],
  };
});

// Import the mocked module to configure per-test
import { plexService } from '../../services/plexService';
import { getFirstForwardedValue } from '../../routes/auth';
const mockedPlex = vi.mocked(plexService);

let app: Express;
let db: DatabaseService;

beforeEach(() => {
  ({ app, db } = createTestApp());
  vi.clearAllMocks();
});

describe('getFirstForwardedValue', () => {
  it('returns undefined for undefined input', () => {
    expect(getFirstForwardedValue(undefined)).toBeUndefined();
  });

  it('returns undefined for empty or whitespace-only strings', () => {
    expect(getFirstForwardedValue('')).toBeUndefined();
    expect(getFirstForwardedValue('   ')).toBeUndefined();
    expect(getFirstForwardedValue(',,,')).toBeUndefined();
  });

  it('extracts single value and trims whitespace', () => {
    expect(getFirstForwardedValue('  https  ')).toBe('https');
  });

  it('extracts first value from comma-separated string', () => {
    expect(getFirstForwardedValue('https, https')).toBe('https');
    expect(getFirstForwardedValue('example.com, internal.proxy:8080')).toBe('example.com');
  });

  it('extracts first value from string array and skips empty entries', () => {
    expect(getFirstForwardedValue(['https', 'http'])).toBe('https');
    expect(getFirstForwardedValue(['', '  https  ', 'http'])).toBe('https');
    expect(getFirstForwardedValue(['example.com, second.com'])).toBe('example.com');
    expect(getFirstForwardedValue([])).toBeUndefined();
  });
});

describe('POST /api/auth/plex/pin', () => {
  it('returns pin data on success', async () => {
    mockedPlex.generatePin.mockResolvedValue(MOCK_PIN);

    const res = await request(app).post('/api/auth/plex/pin');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(MOCK_PIN.id);
    expect(res.body.code).toBe(MOCK_PIN.code);
    expect(res.body.url).toContain('app.plex.tv');
  });

  it('returns 500 when pin generation fails', async () => {
    mockedPlex.generatePin.mockRejectedValue(new Error('Plex API down'));

    const res = await request(app).post('/api/auth/plex/pin');
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('PIN');
  });

  it('normalizes single reverse proxy headers in callback URL', async () => {
    mockedPlex.generatePin.mockResolvedValue(MOCK_PIN);

    const res = await request(app)
      .post('/api/auth/plex/pin')
      .set('x-forwarded-proto', 'https')
      .set('x-forwarded-host', 'plexdownload.cassutti.it');

    expect(res.status).toBe(200);
    expect(res.body.url).toContain('forwardUrl=https%3A%2F%2Fplexdownload.cassutti.it%2Flogin');
  });

  it('normalizes comma-separated reverse proxy headers from chained proxies', async () => {
    mockedPlex.generatePin.mockResolvedValue(MOCK_PIN);

    const res = await request(app)
      .post('/api/auth/plex/pin')
      .set('x-forwarded-proto', 'https, https')
      .set('x-forwarded-host', 'plexdownload.cassutti.it, nginx-proxy:8080');

    expect(res.status).toBe(200);
    expect(res.body.url).toContain('forwardUrl=https%3A%2F%2Fplexdownload.cassutti.it%2Flogin');
    expect(res.body.url).not.toContain('https%2C');
    expect(res.body.url).not.toContain('nginx-proxy');
  });

  it('handles array-based forwarded headers safely', async () => {
    mockedPlex.generatePin.mockResolvedValue(MOCK_PIN);

    const res = await request(app)
      .post('/api/auth/plex/pin')
      .set('x-forwarded-proto', ['https', 'http'] as any)
      .set('x-forwarded-host', ['plexdownload.cassutti.it', 'proxy2'] as any);

    expect(res.status).toBe(200);
    expect(res.body.url).toContain('forwardUrl=https%3A%2F%2Fplexdownload.cassutti.it%2Flogin');
  });

  it('rejects non-http/https protocols from proxy headers and falls back safely', async () => {
    mockedPlex.generatePin.mockResolvedValue(MOCK_PIN);

    const res = await request(app)
      .post('/api/auth/plex/pin')
      .set('x-forwarded-proto', 'javascript, https')
      .set('x-forwarded-host', 'plexdownload.cassutti.it');

    expect(res.status).toBe(200);
    expect(res.body.url).not.toContain('javascript');
    expect(res.body.url).toMatch(/forwardUrl=https?%3A%2F%2Fplexdownload\.cassutti\.it%2Flogin/);
  });
});

describe('POST /api/auth/plex/authenticate', () => {
  it('returns 400 when pinId is missing', async () => {
    const res = await request(app)
      .post('/api/auth/plex/authenticate')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('PIN ID');
  });

  it('returns 400 when PIN is not yet authorized', async () => {
    mockedPlex.checkPin.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/auth/plex/authenticate')
      .send({ pinId: 12345 });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not yet authorized');
  });

  it('returns 403 when user does not have server access', async () => {
    mockedPlex.checkPin.mockResolvedValue(MOCK_AUTH_RESPONSE);
    mockedPlex.getUserServers.mockResolvedValue(MOCK_USER_SERVERS);
    mockedPlex.findBestServerConnection.mockReturnValue({ serverUrl: null, accessToken: null });

    // Configure admin server settings
    await createAdminAndToken(db);
    db.setSetting('plex_url', 'http://localhost:32400');
    db.setSetting('plex_machine_id', 'test-machine-id-123');

    const res = await request(app)
      .post('/api/auth/plex/authenticate')
      .send({ pinId: 12345 });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Access denied');
  });

  it('authenticates successfully with server access', async () => {
    mockedPlex.checkPin.mockResolvedValue(MOCK_AUTH_RESPONSE);
    mockedPlex.getUserServers.mockResolvedValue(MOCK_USER_SERVERS);
    mockedPlex.findBestServerConnection.mockReturnValue({
      serverUrl: 'http://192.168.1.100:32400',
      accessToken: 'shared-access-token',
    });

    // Configure admin server settings
    await createAdminAndToken(db);
    db.setSetting('plex_url', 'http://localhost:32400');
    db.setSetting('plex_machine_id', 'test-machine-id-123');

    const res = await request(app)
      .post('/api/auth/plex/authenticate')
      .send({ pinId: 12345 });
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe(MOCK_AUTH_RESPONSE.user.username);
    expect(res.body.token).toBeDefined();
  });

  it('returns 500 when plex_url is not configured', async () => {
    mockedPlex.checkPin.mockResolvedValue(MOCK_AUTH_RESPONSE);

    const res = await request(app)
      .post('/api/auth/plex/authenticate')
      .send({ pinId: 12345 });
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('not configured');
  });

  it('creates a new plex user on first login', async () => {
    mockedPlex.checkPin.mockResolvedValue(MOCK_AUTH_RESPONSE);
    mockedPlex.getUserServers.mockResolvedValue(MOCK_USER_SERVERS);
    mockedPlex.findBestServerConnection.mockReturnValue({
      serverUrl: 'http://192.168.1.100:32400',
      accessToken: 'shared-access-token',
    });

    await createAdminAndToken(db);
    db.setSetting('plex_url', 'http://localhost:32400');
    db.setSetting('plex_machine_id', 'test-machine-id-123');

    await request(app)
      .post('/api/auth/plex/authenticate')
      .send({ pinId: 12345 });

    // Verify user was created in database
    const plexUser = db.getPlexUserByPlexId(MOCK_AUTH_RESPONSE.user.uuid);
    expect(plexUser).toBeDefined();
    expect(plexUser?.username).toBe(MOCK_AUTH_RESPONSE.user.username);
  });

  it('updates existing plex user on re-login', async () => {
    mockedPlex.checkPin.mockResolvedValue(MOCK_AUTH_RESPONSE);
    mockedPlex.getUserServers.mockResolvedValue(MOCK_USER_SERVERS);
    mockedPlex.findBestServerConnection.mockReturnValue({
      serverUrl: 'http://192.168.1.100:32400',
      accessToken: 'shared-access-token',
    });

    await createAdminAndToken(db);
    db.setSetting('plex_url', 'http://localhost:32400');
    db.setSetting('plex_machine_id', 'test-machine-id-123');

    // First login
    await request(app)
      .post('/api/auth/plex/authenticate')
      .send({ pinId: 12345 });

    // Second login
    const res = await request(app)
      .post('/api/auth/plex/authenticate')
      .send({ pinId: 12345 });
    expect(res.status).toBe(200);

    // Should still be only one user
    const users = db.getAllUsers();
    const plexUsers = users.filter(u => u.type === 'plex');
    expect(plexUsers.length).toBe(1);
  });
});
