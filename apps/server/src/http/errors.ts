import type { FastifyReply } from "fastify";

export function apiError(reply: FastifyReply, status: number, body: unknown): FastifyReply {
  return reply.code(status).type("application/json; charset=utf-8").send(body);
}

export interface ParsePos {
  line: number;
  column: number;
  id: number;
  location: string;
}

export const missingRef = (reply: FastifyReply) =>
  apiError(reply, 400, { type: "api_validation_error", message: "Please specify ref" });

export const refNotFound = (reply: FastifyReply, master: string) =>
  apiError(reply, 404, {
    type: "api_notfound_error",
    message: `Ref not found. Ensure you have the correct ref and try again. Master ref is: ${master}`,
  });

export const refExpired = (reply: FastifyReply, master: string) =>
  apiError(reply, 410, {
    type: "api_validation_error",
    message: `Ref is expired. Ensure you have the correct ref and try again. Master ref is: ${master}`,
  });

export const parsingError = (reply: FastifyReply, message: string, pos: ParsePos) =>
  apiError(reply, 400, { type: "api_parsing_error", message, pos });

export const invalidToken = (reply: FastifyReply) =>
  apiError(reply, 401, { error: "Invalid access token" });

export const previewExpired = (reply: FastifyReply) =>
  apiError(reply, 404, { type: "api_security_error", message: "The preview token has expired" });

export const repositoryNotFound = (reply: FastifyReply) =>
  apiError(reply, 404, { type: "api_notfound_error", message: "Repository not found" });

export const writeRepositoryNotFound = (reply: FastifyReply) =>
  apiError(reply, 403, { message: "Repository not found" });
