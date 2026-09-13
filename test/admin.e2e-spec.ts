/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { DatabaseService } from '../src/modules/database/database.service';
import {
  createTestApp,
  cleanupTestCategoryMappings,
} from './helpers/test-helpers';

describe('Admin API & Dashboard (e2e)', () => {
  let app: INestApplication;
  let db: DatabaseService;
  let adminApiKey: string;
  const createdCategories: string[] = [];

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DatabaseService);
    const config = app.get(ConfigService);
    adminApiKey = config.getOrThrow<string>('ADMIN_API_KEY');
  });

  afterAll(async () => {
    if (createdCategories.length > 0) {
      await cleanupTestCategoryMappings(db, createdCategories);
    }
    await app.close();
  });

  describe('Authentication & Security', () => {
    it('should reject requests to admin endpoints without x-api-key with 401 Unauthorized', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/stats')
        .expect(401);

      expect(res.body.message).toBe('Unauthorized: Invalid or missing API key');
    });

    it('should reject requests with an incorrect x-api-key with 401 Unauthorized', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/stats')
        .set('x-api-key', 'wrong_key_12345')
        .expect(401);

      expect(res.body.message).toBe('Unauthorized: Invalid or missing API key');
    });
  });

  describe('Dashboard Statistics', () => {
    it('should return aggregated sync statistics with valid x-api-key', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/stats')
        .set('x-api-key', adminApiKey)
        .expect(200);

      expect(res.body).toHaveProperty('synced');
      expect(res.body).toHaveProperty('pending');
      expect(res.body).toHaveProperty('failed');
      expect(res.body).toHaveProperty('total');
      expect(typeof res.body.synced).toBe('number');
      expect(typeof res.body.pending).toBe('number');
      expect(typeof res.body.failed).toBe('number');
      expect(typeof res.body.total).toBe('number');
    });
  });

  describe('Category GL Mapping CRUD Lifecycle', () => {
    const testCategory = `e2e_cat_${Date.now()}`;

    it('should list all category GL mappings', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/mappings')
        .set('x-api-key', adminApiKey)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
    });

    it('should create a new category mapping', async () => {
      createdCategories.push(testCategory);

      const res = await request(app.getHttpServer())
        .post('/api/v1/admin/mappings')
        .set('x-api-key', adminApiKey)
        .send({
          category: testCategory,
          expense_account: '600777',
          description: 'E2E Testing Category',
        })
        .expect(201);

      expect(res.body).toEqual({
        category: testCategory.toLowerCase(),
        expense_account: '600777',
        description: 'E2E Testing Category',
      });

      // Verify in DB
      const dbRes = await db.query(
        'SELECT expense_account FROM category_gl_mapping WHERE category = $1',
        [testCategory.toLowerCase()],
      );
      expect(dbRes.rows.length).toBe(1);
      expect(dbRes.rows[0].expense_account).toBe('600777');
    });

    it('should reject duplicate category mapping creation with 409 Conflict', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/admin/mappings')
        .set('x-api-key', adminApiKey)
        .send({
          category: testCategory,
          expense_account: '600888',
        })
        .expect(409);
    });

    it('should update an existing category mapping', async () => {
      const res = await request(app.getHttpServer())
        .put(`/api/v1/admin/mappings/${testCategory}`)
        .set('x-api-key', adminApiKey)
        .send({
          expense_account: '600999',
          description: 'Updated E2E Description',
        })
        .expect(200);

      expect(res.body).toEqual({
        category: testCategory.toLowerCase(),
        expense_account: '600999',
        description: 'Updated E2E Description',
      });
    });

    it('should return 404 when updating non-existent category mapping', async () => {
      await request(app.getHttpServer())
        .put('/api/v1/admin/mappings/non_existent_category_xyz')
        .set('x-api-key', adminApiKey)
        .send({ expense_account: '600100' })
        .expect(404);
    });

    it('should delete an existing category mapping with 204 No Content', async () => {
      await request(app.getHttpServer())
        .delete(`/api/v1/admin/mappings/${testCategory}`)
        .set('x-api-key', adminApiKey)
        .expect(204);

      // Verify removal from DB
      const dbRes = await db.query(
        'SELECT category FROM category_gl_mapping WHERE category = $1',
        [testCategory.toLowerCase()],
      );
      expect(dbRes.rows.length).toBe(0);
    });

    it('should return 404 when deleting a non-existent category mapping', async () => {
      await request(app.getHttpServer())
        .delete('/api/v1/admin/mappings/non_existent_category_xyz')
        .set('x-api-key', adminApiKey)
        .expect(404);
    });
  });

  describe('Sync History, Failures, and Bulk Retry', () => {
    it('should retrieve sync history with limit parameter', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/sync-history?limit=10')
        .set('x-api-key', adminApiKey)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
    });

    it('should retrieve sync failures with limit parameter', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/sync-failures?limit=10')
        .set('x-api-key', adminApiKey)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
    });

    it('should support bulk retrying of failed/exhausted sync jobs', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/admin/sync-failures/retry-all')
        .set('x-api-key', adminApiKey)
        .expect(200);

      expect(res.body).toHaveProperty('count');
      expect(res.body).toHaveProperty('message');
      expect(res.body).toHaveProperty('journalIds');
      expect(Array.isArray(res.body.journalIds)).toBe(true);
    });
  });

  describe('Bull Board Dashboard Authentication', () => {
    it('should challenge unauthenticated requests to /admin/queues with 401 and WWW-Authenticate', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/queues')
        .expect(401);

      expect(res.headers['www-authenticate']).toContain(
        'Basic realm="SpendSync Bull Board"',
      );
    });

    it('should allow access to /admin/queues with valid HTTP Basic Auth', async () => {
      const basicAuthToken = Buffer.from(`admin:${adminApiKey}`).toString(
        'base64',
      );

      const res = await request(app.getHttpServer())
        .get('/admin/queues')
        .set('Authorization', `Basic ${basicAuthToken}`)
        .expect(200);

      expect(res.text).toContain('BullMQ');
    });

    it('should allow access to /admin/queues with valid x-api-key header', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/queues')
        .set('x-api-key', adminApiKey)
        .expect(200);

      expect(res.text).toContain('BullMQ');
    });
  });
});
