/**
 * JWT Auth Middleware — Fastify preHandler for protected routes.
 */

import config from '../config.js';

/**
 * Register the authenticate decorator on the Fastify instance.
 */
export function registerAuth(fastify) {
  // Register JWT plugin
  fastify.register(import('@fastify/jwt'), {
    secret: config.jwt.secret,
    sign: {
      expiresIn: config.jwt.expiresIn,
    },
    cookie: {
      cookieName: 'token',
      signed: false,
    },
  });

  // Decorate with authenticate method
  fastify.decorate('authenticate', async function (request, reply) {
    try {
      // Try cookie first, then Authorization header
      const token =
        request.cookies?.token ||
        request.headers.authorization?.replace('Bearer ', '');

      if (!token) {
        return reply.redirect('/login');
      }

      // Verify and attach to request
      request.user = fastify.jwt.verify(token);
    } catch (err) {
      // For API routes, return 401 JSON
      if (request.url.startsWith('/api/') || request.url.startsWith('/whatsapp/')) {
        return reply.status(401).send({
          success: false,
          message: 'Unauthorized — invalid or expired token',
        });
      }
      // For page routes, redirect to login
      return reply.redirect('/login');
    }
  });
}
