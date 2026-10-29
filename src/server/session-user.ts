import type { Request, Response } from 'express';
import type express from 'express';

export type SystemRole = 'admin' | 'operator' | 'solicitante' | 'dashboard';

export interface SessionUser {
  id: string;
  username: string;
  role: SystemRole;
  areaId: string | null;
  areaNombre: string | null;
}

declare module 'express-session' {
  interface SessionData {
    user?: SessionUser;
  }
}

export function requireRoles(
  roles: readonly SystemRole[],
): (request: Request, response: Response, next: express.NextFunction) => void {
  return (request, response, next) => {
    if (!request.session.user) {
      response.status(401).json({ error: 'Iniciá sesión para continuar.' });
      return;
    }
    if (!roles.includes(request.session.user.role)) {
      response.status(403).json({ error: 'Permisos insuficientes.' });
      return;
    }
    next();
  };
}
