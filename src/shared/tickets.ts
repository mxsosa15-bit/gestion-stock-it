export const TICKET_CATEGORIES = [
  'Impresora',
  'Monitor',
  'Internet',
  'Turnero',
  'Pantallas',
  'Computadora',
  'Red',
  'Otros',
] as const;

export type TicketCategory = (typeof TICKET_CATEGORIES)[number];
