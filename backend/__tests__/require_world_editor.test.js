import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const { authenticate, requireWorldEditor, elevatedUsers } = require_('../middleware/auth.js');

process.env.JWT_SECRET = 'test-secret';
const sign = (payload) => jwt.sign(payload, 'test-secret');

const ADMIN = sign({ id: 1, username: 'admin', role: 'admin', isTemporary: false });
const PLAYER = sign({ username: 'runner', role: 'player', isTemporary: false });
const TEMP = sign({ username: 'guest', isTemporary: true });
const TEMP_ADMIN = sign({ username: 'guest_admin', role: 'admin', isTemporary: true });

const app = express();
app.get('/guarded', authenticate, requireWorldEditor, (req, res) => res.json({ ok: true, user: req.user.username }));

const callAs = (token) => {
  const r = request(app).get('/guarded');
  return token ? r.set('Authorization', `Bearer ${token}`) : r;
};

describe('requireWorldEditor', () => {
  it('rejects a request with no credentials as unauthenticated', async () => {
    const res = await callAs(null);
    expect(res.status).toBe(401);
  });

  it('rejects a player token', async () => {
    const res = await callAs(PLAYER);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/primary administrator/i);
  });

  // An elevated temporary user clears `authenticate` — that is the whole point of
  // elevation — so this is the case the boundary exists for.
  it('rejects an elevated temporary admin', async () => {
    elevatedUsers.add('guest_admin');
    try {
      const res = await callAs(TEMP_ADMIN);
      expect(res.status).toBe(403);
    } finally {
      elevatedUsers.delete('guest_admin');
    }
  });

  it('rejects an unelevated temporary token before it reaches the check', async () => {
    const res = await callAs(TEMP);
    expect(res.status).toBe(401);
  });

  it('allows the primary administrator', async () => {
    const res = await callAs(ADMIN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, user: 'admin' });
  });

  it('rejects an admin token that simply omits isTemporary', async () => {
    const res = await callAs(sign({ username: 'ambiguous', role: 'admin' }));
    expect(res.status).toBe(403);
  });
});
