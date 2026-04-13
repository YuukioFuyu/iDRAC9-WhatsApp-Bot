/**
 * Auth routes — login/logout with JWT in httpOnly cookies.
 */

import bcrypt from 'bcrypt';
import { queryOne } from '../services/db.js';
import logger from '../services/logger.js';

export default async function authRoutes(fastify) {
  // ── GET /login — render login page ──────────────
  fastify.get('/login', async (request, reply) => {
    // If already authenticated, redirect to dashboard
    try {
      const token = request.cookies?.token;
      if (token) {
        fastify.jwt.verify(token);
        return reply.redirect('/dashboard');
      }
    } catch {
      // Token invalid, show login
    }

    return reply.view('login.html', {
      error: request.query.error || null,
    });
  });

  // ── POST /auth/login — authenticate ─────────────
  fastify.post('/auth/login', async (request, reply) => {
    const { username, password } = request.body || {};

    if (!username || !password) {
      return reply.redirect('/login?error=Missing+credentials');
    }

    // Find user in database
    const user = await queryOne(
      'SELECT id, username, password_hash FROM users WHERE username = $1',
      [username]
    );

    if (!user) {
      logger.warn({ username }, 'Login failed — user not found');
      return reply.redirect('/login?error=Invalid+credentials');
    }

    // Verify password
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      logger.warn({ username }, 'Login failed — wrong password');
      return reply.redirect('/login?error=Invalid+credentials');
    }

    // Generate JWT
    const token = fastify.jwt.sign({
      id: user.id,
      username: user.username,
    });

    logger.info({ username }, 'Login successful');

    // Set httpOnly cookie
    // secure: auto-detect from request protocol (allows HTTP on local/internal network)
    // sameSite: 'lax' allows the cookie to be sent after the POST→redirect login flow
    const isSecure = request.protocol === 'https' || request.headers['x-forwarded-proto'] === 'https';
    return reply
      .setCookie('token', token, {
        path: '/',
        httpOnly: true,
        secure: isSecure,
        sameSite: 'lax',
        maxAge: 86400, // 24h in seconds
      })
      .redirect('/dashboard');
  });

  // ── POST /auth/logout ───────────────────────────
  fastify.post('/auth/logout', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    logger.info({ username: request.user.username }, 'Logout');

    return reply
      .clearCookie('token', { path: '/' })
      .redirect('/login');
  });

  // ── GET /auth/logout (convenience) ──────────────
  fastify.get('/auth/logout', async (request, reply) => {
    return reply
      .clearCookie('token', { path: '/' })
      .redirect('/login');
  });
}
