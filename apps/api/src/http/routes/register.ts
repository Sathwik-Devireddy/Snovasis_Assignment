import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Prisma } from "../../generated/prisma/index.js";
import type { PrismaClient } from "../../infrastructure/prisma.js";
import { DomainError } from "../errors.js";
import { hashPassword, isArgon2idHash } from "../../infrastructure/argon2.js";
import { rateLimiter, type RateLimitDeps } from "../../infrastructure/rateLimiter.js";
import { assertMutationHeaders } from "../guards.js";

/**
 * POST /register — holder onboarding (PHASE-05 P5.10; REG-001/REG-002,
 * AUTHZ_MATRIX §C.1 amendment).
 *
 * Authority floor (the point of P5.10/adversarial Gate 5): registration can
 * NEVER create an ADMIN or AUDITOR (the role column is the server-side
 * constant `ACCOUNT_HOLDER` — the strict schema makes every escalation
 * attempt an invalid body), it never creates an account, never grants a
 * permission, never touches money authority. Duplicate emails return the
 * SAME uniform envelope as any other invalid registration (no enumeration —
 * REG-002); the limiter runs before any handler logic so floods produce no
 * side effects at all (RATE-001).
 */

const RegistrationBody = z
  .object({
    email: z.string().email().max(254),
    password: z.string().min(10).max(200),
  })
  .strict();

export function registerRegisterRoute(
  app: FastifyInstance,
  deps: { prisma: PrismaClient; rateLimits: RateLimitDeps },
): void {
  app.post(
    "/register",
    {
      // MUTATION GUARDS first (P5.6 origin/content-type); IP-keyed limiter
      // SECOND: floods create no rows and no hashes (RATE-001).
      preHandler: [assertMutationHeaders, rateLimiter("register", deps.rateLimits)],
    },
    async (request, reply) => {
      const parsed = RegistrationBody.safeParse(request.body);
      if (!parsed.success) {
        // Uniform refusal for EVERY invalid registration (malformed body,
        // weak password, escalation attempt) — no signal distinguishes them
        // outside the server log + audit trail (REG-002).
        throw new DomainError("VALIDATION_FAILED", "Registration failed.");
      }
      const { email, password } = parsed.data;
      const normalizedEmail = email.toLowerCase();

      const passwordHash = await hashPassword(password);
      if (!isArgon2idHash(passwordHash)) {
        throw new DomainError("INFRA_FAILURE", "Internal infrastructure failure.");
      }

      // The UNIQUE constraint is the real duplicate defence (compare-then-
      // insert would race); any unique violation maps into the same uniform
      // envelope below (REG-002).
      //
      // Atomicity: the user row and its USER_REGISTERED audit event commit
      // together or roll back together (master-stabilisation 4.2) — a failed
      // audit insert must not leave a user without its registration record.
      try {
        const created = await deps.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          const user = await tx.user.create({
            data: {
              email: normalizedEmail,
              passwordHash,
              role: "ACCOUNT_HOLDER", // server-fixed, never from the request body
              status: "ACTIVE",
            },
            select: { id: true, email: true, role: true },
          });
          await tx.auditEvent.create({
            data: {
              actorId: user.id,
              eventType: "USER_REGISTERED",
              subjectType: "user",
              subjectId: user.id.toString(),
              metadata: { role: "ACCOUNT_HOLDER" },
            },
          });
          return user;
        });
        return await reply
          .code(201)
          .send({ user: { id: created.id.toString(), email: created.email, role: created.role } });
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "P2002") {
          throw new DomainError("VALIDATION_FAILED", "Registration failed.");
        }
        throw error;
      }
    },
  );
}
