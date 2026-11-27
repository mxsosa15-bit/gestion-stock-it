import express from 'express';
import type { Pool } from 'pg';
import XLSX from 'xlsx-js-style';
import { DEFAULT_SEDE_ID } from '../shared/locations';
import {
  excludeAuditedStockMovementHistory,
  inventoryHistoryAuditEvents,
} from './operator-audit';
import { parseOptionalDate, parseOptionalText, parsePageOptions } from './list-query';
import { requireRoles } from './session-user';

type ReportId = 'inventory' | 'stock' | 'transfers' | 'tickets' | 'tasks' | 'activity';
type ReportValue = string | number | null;
type ReportRow = Record<string, ReportValue>;

interface ReportColumn {
  key: string;
  label: string;
}

interface ReportFilters {
  search: string | null;
  site: string | null;
  area: string | null;
  operator: string | null;
  from: string | null;
  to: string | null;
  state: string | null;
  category: string | null;
  type: string | null;
  module: string | null;
  action: string | null;
  sort: 'newest' | 'oldest';
}

interface PageOptions {
  page: number;
  pageSize: number;
  offset: number;
}

interface ReportData {
  title: string;
  columns: ReportColumn[];
  items: ReportRow[];
  total: number;
  page: number;
  pageSize: number;
  generatedAt: string;
  criteria: { label: string; value: string }[];
}

interface LocationRow {
  id: string;
  nombre: string;
}

const requireReportAccess = requireRoles(['admin', 'operator']);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const reportDefinitions: Record<ReportId, { title: string; sheet: string; columns: ReportColumn[] }> = {
  inventory: {
    title: 'Inventario y patrimonio',
    sheet: 'Inventario',
    columns: [
      { key: 'clase', label: 'Clase de activo' },
      { key: 'tipo', label: 'Tipo' },
      { key: 'activo', label: 'Activo' },
      { key: 'marca', label: 'Marca' },
      { key: 'modelo', label: 'Modelo' },
      { key: 'especificacion', label: 'Especificación' },
      { key: 'sede', label: 'Sede' },
      { key: 'area', label: 'Área' },
      { key: 'puesto', label: 'Puesto' },
      { key: 'usuario', label: 'Usuario asignado' },
      { key: 'serie', label: 'Número de serie' },
      { key: 'codigo', label: 'Código de seguimiento' },
      { key: 'patrimonio', label: 'Número patrimonial' },
      { key: 'estado', label: 'Estado registrado' },
      { key: 'fecha', label: 'Fecha registrada' },
    ],
  },
  stock: {
    title: 'Existencias y movimientos de stock',
    sheet: 'Stock',
    columns: [
      { key: 'registro', label: 'Registro' },
      { key: 'fecha', label: 'Fecha' },
      { key: 'sede', label: 'Sede' },
      { key: 'sedeDestino', label: 'Sede de destino' },
      { key: 'tipo', label: 'Tipo' },
      { key: 'producto', label: 'Producto' },
      { key: 'disponible', label: 'Cantidad disponible' },
      { key: 'minimo', label: 'Stock mínimo' },
      { key: 'cantidad', label: 'Cantidad del movimiento' },
      { key: 'operador', label: 'Operador' },
      { key: 'detalle', label: 'Detalle' },
    ],
  },
  transfers: {
    title: 'Transferencias',
    sheet: 'Transferencias',
    columns: [
      { key: 'fecha', label: 'Fecha' },
      { key: 'responsable', label: 'Responsable' },
      { key: 'tipo', label: 'Tipo de transferencia' },
      { key: 'elemento', label: 'Elemento' },
      { key: 'cantidad', label: 'Cantidad' },
      { key: 'motivo', label: 'Motivo / detalle registrado' },
      { key: 'sedeOrigen', label: 'Sede de origen' },
      { key: 'areaOrigen', label: 'Área de origen' },
      { key: 'puestoOrigen', label: 'Puesto de origen (ID)' },
      { key: 'sedeDestino', label: 'Sede de destino' },
      { key: 'areaDestino', label: 'Área de destino' },
      { key: 'puestoDestino', label: 'Puesto de destino (ID)' },
    ],
  },
  tickets: {
    title: 'Tickets de soporte',
    sheet: 'Tickets',
    columns: [
      { key: 'fecha', label: 'Fecha de creación' },
      { key: 'sede', label: 'Sede' },
      { key: 'area', label: 'Área' },
      { key: 'estado', label: 'Estado' },
      { key: 'categoria', label: 'Categoría' },
      { key: 'asunto', label: 'Asunto' },
      { key: 'descripcion', label: 'Descripción' },
      { key: 'solicitante', label: 'Solicitante' },
      { key: 'afectado', label: 'Puesto o usuario afectado' },
      { key: 'solucion', label: 'Solución registrada' },
    ],
  },
  tasks: {
    title: 'Tareas de operadores',
    sheet: 'Tareas',
    columns: [
      { key: 'fecha', label: 'Fecha de realización' },
      { key: 'registrada', label: 'Fecha de registro' },
      { key: 'sede', label: 'Sede' },
      { key: 'area', label: 'Área / sector' },
      { key: 'tipo', label: 'Tipo de tarea' },
      { key: 'tarea', label: 'Tarea' },
      { key: 'detalle', label: 'Descripción' },
      { key: 'observaciones', label: 'Observaciones' },
      { key: 'operador', label: 'Operador' },
      { key: 'relatedAssetType', label: 'Tipo de equipo relacionado' },
      { key: 'relatedAssetId', label: 'ID de equipo relacionado' },
      { key: 'duracionMinutos', label: 'Duración (minutos)' },
    ],
  },
  activity: {
    title: 'Registro de actividades',
    sheet: 'Actividades',
    columns: [
      { key: 'fecha', label: 'Fecha' },
      { key: 'operador', label: 'Usuario' },
      { key: 'modulo', label: 'Módulo' },
      { key: 'accion', label: 'Acción' },
      { key: 'elemento', label: 'Elemento' },
      { key: 'resultado', label: 'Resultado' },
      { key: 'detalle', label: 'Detalle registrado' },
    ],
  },
};

function isReportId(value: string): value is ReportId {
  return Object.prototype.hasOwnProperty.call(reportDefinitions, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalize(value: unknown): string {
  return text(value)
    .trim()
    .toLocaleLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function reportValue(value: unknown): ReportValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  return JSON.stringify(value);
}

function parseFilters(query: express.Request['query']): ReportFilters | null {
  const search = parseOptionalText(query['search'], 200);
  const rawSite = query['site'];
  const site = parseOptionalText(rawSite, 64);
  const area = parseOptionalText(query['area'], 120);
  const operator = parseOptionalText(query['operator'], 64);
  const from = parseOptionalDate(query['from']);
  const to = parseOptionalDate(query['to']);
  const state = parseOptionalText(query['state'], 40);
  const category = parseOptionalText(query['category'], 64);
  const type = parseOptionalText(query['type'], 64);
  const module = parseOptionalText(query['module'], 100);
  const action = parseOptionalText(query['action'], 120);
  const rawSort = parseOptionalText(query['sort'], 16);
  if (
    search === undefined ||
    site === undefined ||
    area === undefined ||
    operator === undefined ||
    from === undefined ||
    to === undefined ||
    state === undefined ||
    category === undefined ||
    type === undefined ||
    module === undefined ||
    action === undefined ||
    rawSort === undefined ||
    (site !== null && !uuidPattern.test(site)) ||
    (from !== null && to !== null && from > to) ||
    (rawSort !== null && rawSort !== 'newest' && rawSort !== 'oldest')
  ) {
    return null;
  }
  return {
    search,
    site,
    area,
    operator,
    from,
    to,
    state,
    category,
    type,
    module,
    action,
    sort: rawSort ?? 'newest',
  };
}

function dateMatches(value: unknown, from: string | null, to: string | null): boolean {
  if (!from && !to) return true;
  const date = value instanceof Date ? value.toISOString() : text(value);
  if (!date) return false;
  const day = date.slice(0, 10);
  return (!from || day >= from) && (!to || day <= to);
}

function textMatches(value: unknown, query: string | null): boolean {
  return !query || normalize(value).includes(normalize(query));
}

function reportSearchText(row: ReportRow): string {
  return Object.entries(row)
    .filter(([key]) => !key.startsWith('_'))
    .map(([, value]) => String(value ?? ''))
    .join(' ');
}

function paginateArray(
  rows: ReportRow[],
  page: PageOptions,
  orderKey: string,
  direction: 'newest' | 'oldest',
): ReportRow[] {
  const sorted = [...rows].sort((left, right) => {
    const a = String(left[orderKey] ?? '');
    const b = String(right[orderKey] ?? '');
    const comparison = a.localeCompare(b);
    return direction === 'newest' ? -comparison : comparison;
  });
  return sorted.slice(page.offset, page.offset + page.pageSize);
}

function getSnapshotRows(snapshot: unknown, key: string): Record<string, unknown>[] {
  if (!isRecord(snapshot) || !Array.isArray(snapshot[key])) return [];
  return (snapshot[key] as unknown[]).filter(isRecord);
}

async function loadLocations(pool: Pool): Promise<{
  sitesById: Map<string, string>;
  areasById: Map<string, Record<string, unknown>>;
  floorsById: Map<string, Record<string, unknown>>;
}> {
  const [sites, inventory] = await Promise.all([
    pool.query<LocationRow>('SELECT id::text, nombre FROM gestion_it.sedes'),
    pool.query<{ payload: unknown }>(
      'SELECT payload FROM gestion_it.inventory_snapshot WHERE singleton_id = true',
    ),
  ]);
  const payload = inventory.rows[0]?.payload;
  return {
    sitesById: new Map(sites.rows.map((site) => [site.id, site.nombre])),
    areasById: new Map(
      getSnapshotRows(payload, 'areas').map((area) => [text(area['id']), area]),
    ),
    floorsById: new Map(
      getSnapshotRows(payload, 'pisos').map((floor) => [text(floor['id']), floor]),
    ),
  };
}

function siteName(siteId: string, sites: Map<string, string>): string {
  return sites.get(siteId) ?? (siteId === DEFAULT_SEDE_ID ? 'Casa Central' : 'Sede no identificada');
}

function locationSiteId(
  areaId: string,
  areas: Map<string, Record<string, unknown>>,
  floors: Map<string, Record<string, unknown>>,
): string {
  const area = areas.get(areaId);
  const floor = area ? floors.get(text(area['pisoId'])) : undefined;
  return text(floor?.['sedeId']) || DEFAULT_SEDE_ID;
}

function matchesCommon(
  row: ReportRow,
  filters: ReportFilters,
  siteId: string,
  areaValue: string,
  operatorValue = '',
): boolean {
  return (
    (!filters.site || siteId === filters.site) &&
    textMatches(areaValue, filters.area) &&
    textMatches(operatorValue, filters.operator) &&
    textMatches(reportSearchText(row), filters.search)
  );
}

function criteriaFor(
  filters: ReportFilters,
  sites: Map<string, string>,
  reportId: ReportId,
): ReportData['criteria'] {
  const entries: [string, string | null][] = [
    ['Sede / delegación', filters.site],
    ['Área / sector', filters.area],
    ['Operador / responsable', filters.operator],
    ['Fecha desde', filters.from],
    ['Fecha hasta', filters.to],
    ['Estado', filters.state],
    ['Categoría', filters.category],
    ['Tipo', filters.type],
    ['Módulo', filters.module],
    ['Acción', filters.action],
    ['Búsqueda', filters.search],
    ...(reportId === 'inventory'
      ? []
      : [['Orden', filters.sort === 'newest' ? 'Más recientes' : 'Más antiguas'] as [
          string,
          string,
        ]]),
  ];
  return entries
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .map(([label, value]) => ({
      label,
      value: label === 'Sede / delegación' ? siteName(value, sites) || value : value,
    }));
}

async function createArrayReport(
  pool: Pool,
  reportId: 'inventory' | 'stock',
  filters: ReportFilters,
  page: PageOptions,
  includeAll: boolean,
): Promise<{ items: ReportRow[]; total: number; locations: Awaited<ReturnType<typeof loadLocations>> }> {
  const locations = await loadLocations(pool);
  const snapshotResult = await pool.query<{ payload: unknown }>(
    'SELECT payload FROM gestion_it.inventory_snapshot WHERE singleton_id = true',
  );
  const payload = snapshotResult.rows[0]?.payload;
  const areas = locations.areasById;
  const floors = locations.floorsById;
  const sites = locations.sitesById;

  if (reportId === 'inventory') {
    const assets: ReportRow[] = [];
    for (const workstation of getSnapshotRows(payload, 'puestos')) {
      const areaId = text(workstation['areaId']);
      const area = areas.get(areaId);
      const floor = area ? floors.get(text(area['pisoId'])) : undefined;
      const siteId = text(floor?.['sedeId']) || DEFAULT_SEDE_ID;
      const areaName = text(area?.['nombre']) || '';
      assets.push({
        clase: 'PUESTO',
        tipo: 'PUESTO',
        activo: text(workstation['nombrePuesto']),
        marca: '',
        modelo: '',
        especificacion: '',
        sede: siteName(siteId, sites),
        area: areaName,
        puesto: text(workstation['nombrePuesto']),
        usuario: text(workstation['usuarioAsignado']),
        serie: '',
        codigo: text(workstation['codigoSeguimiento']),
        patrimonio: '',
        estado: '',
        fecha: null,
        _siteId: siteId,
        _areaId: areaId,
      });
      for (const component of Array.isArray(workstation['componentes'])
        ? workstation['componentes'].filter(isRecord)
        : []) {
        assets.push({
          clase: 'COMPONENTE',
          tipo: text(component['tipo']),
          activo: text(component['tipo']),
          marca: text(component['marca']),
          modelo: text(component['modelo']),
          especificacion: text(component['especificacion']),
          sede: siteName(siteId, sites),
          area: areaName,
          puesto: text(workstation['nombrePuesto']),
          usuario: text(workstation['usuarioAsignado']),
          serie: text(component['numeroSerie']),
          codigo: text(component['codigoSeguimiento']),
          patrimonio: '',
          estado: '',
          fecha: null,
          _siteId: siteId,
          _areaId: areaId,
        });
      }
    }

    for (const equipment of getSnapshotRows(payload, 'equiposRed')) {
      const areaId = text(equipment['areaId']);
      const area = areas.get(areaId);
      const siteId = locationSiteId(areaId, areas, floors);
      assets.push({
        clase: 'EQUIPO_RED',
        tipo: text(equipment['tipo']),
        activo: `${text(equipment['marca'])} ${text(equipment['modelo'])}`.trim(),
        marca: text(equipment['marca']),
        modelo: text(equipment['modelo']),
        especificacion: '',
        sede: siteName(siteId, sites),
        area: text(area?.['nombre']),
        puesto: '',
        usuario: '',
        serie: '',
        codigo: text(equipment['codigoSeguimiento']),
        patrimonio: '',
        estado: '',
        fecha: null,
        _siteId: siteId,
        _areaId: areaId,
      });
    }

    for (const retired of getSnapshotRows(payload, 'componentesRetirados')) {
      const component = isRecord(retired['componente']) ? retired['componente'] : {};
      const workstation = getSnapshotRows(payload, 'puestos').find(
        (item) => item['id'] === retired['puestoId'],
      );
      const areaId = text(workstation?.['areaId']);
      const area = areas.get(areaId);
      const siteId =
        text(retired['sedeId']) || locationSiteId(areaId, areas, floors);
      assets.push({
        clase: 'COMPONENTE_RETIRADO',
        tipo: text(component['tipo']),
        activo: `${text(component['marca'])} ${text(component['modelo'])}`.trim(),
        marca: text(component['marca']),
        modelo: text(component['modelo']),
        especificacion: text(component['especificacion']),
        sede: siteName(siteId, sites),
        area: text(area?.['nombre']),
        puesto: text(retired['puestoNombre']) || text(workstation?.['nombrePuesto']),
        usuario: text(workstation?.['usuarioAsignado']),
        serie: text(component['numeroSerie']),
        codigo: text(component['codigoSeguimiento']),
        patrimonio: '',
        estado: text(retired['estado']),
        fecha: reportValue(retired['fechaRetiro']),
        _siteId: siteId,
        _areaId: areaId,
      });
    }

    const patrimony = await pool.query<Record<string, unknown>>(
      `SELECT asset.tipo, asset.marca, asset.modelo, asset.especificacion,
              asset.numero_serie AS serie, asset.numero_patrimonio AS patrimonio,
              asset.sede_id::text AS site_id, asset.fecha_registro AS fecha
       FROM gestion_it.hardware_assets AS asset`,
    );
    for (const asset of patrimony.rows) {
      const siteId = text(asset['site_id']) || DEFAULT_SEDE_ID;
      assets.push({
        clase: 'PATRIMONIAL',
        tipo: text(asset['tipo']),
        activo: `${text(asset['marca'])} ${text(asset['modelo'])}`.trim(),
        marca: text(asset['marca']),
        modelo: text(asset['modelo']),
        especificacion: text(asset['especificacion']),
        sede: siteName(siteId, sites),
        area: '',
        puesto: '',
        usuario: '',
        serie: text(asset['serie']),
        codigo: '',
        patrimonio: text(asset['patrimonio']),
        estado: '',
        fecha: reportValue(asset['fecha']),
        _siteId: siteId,
        _areaId: '',
      });
    }
    const filtered = assets.filter((row) => {
      const areaId = text(row['_areaId']);
      const areaName = text(row['area']);
      const typeMatches = !filters.type || row['clase'] === filters.type;
      const stateMatches = !filters.state || row['estado'] === filters.state;
      return (
        typeMatches &&
        stateMatches &&
        dateMatches(row['fecha'], filters.from, filters.to) &&
        matchesCommon(row, filters, text(row['_siteId']), areaName)
      );
    });
    const clean = filtered.map(({ _siteId: _site, _areaId: _area, ...row }) => row);
    return {
      items: includeAll ? clean : paginateArray(clean, page, 'activo', 'oldest'),
      total: clean.length,
      locations,
    };
  }

  const rows: ReportRow[] = [];
  const stockItems = getSnapshotRows(payload, 'stock');
  const stockById = new Map(stockItems.map((item) => [text(item['id']), item]));
  for (const item of getSnapshotRows(payload, 'stock')) {
    const siteId = text(item['sedeId']) || DEFAULT_SEDE_ID;
    const product = `${text(item['tipo'])} ${text(item['marca'])} ${text(item['especificacion'])}`.trim();
    const available = Number(item['cantidadDisponible']);
    const minimum = Number(item['stockMinimo']);
    const state = available === 0 ? 'SIN_STOCK' : available <= minimum ? 'BAJO' : 'DISPONIBLE';
    const row: ReportRow = {
      registro: 'Existencia',
      fecha: null,
      sede: siteName(siteId, sites),
      sedeDestino: '',
      tipo: text(item['tipo']),
      producto: product,
      disponible: Number.isFinite(available) ? available : null,
      minimo: Number.isFinite(minimum) ? minimum : null,
      cantidad: null,
      operador: '',
      detalle: '',
      _siteId: siteId,
      _state: state,
    };
    if (
      (!filters.type || text(item['tipo']) === filters.type) &&
      (!filters.state || state === filters.state) &&
      !filters.from &&
      !filters.to &&
      matchesCommon(row, filters, siteId, '', '')
    ) {
      rows.push(row);
    }
  }

  for (const movement of getSnapshotRows(payload, 'historial')) {
    const movementType = text(movement['tipo']);
    const stockItem = stockById.get(text(movement['insumoId']));
    if (
      !stockItem &&
      !['INGRESO_STOCK', 'SALDO_INICIAL', 'AJUSTE_STOCK', 'TRANSFERENCIA_STOCK'].includes(
        movementType,
      )
    ) {
      continue;
    }
    const siteId = text(movement['sedeId']) || text(stockItem?.['sedeId']);
    const destinationId = text(movement['sedeDestinoId']);
    const product = stockItem
      ? `${text(stockItem['tipo'])} ${text(stockItem['marca'])} ${text(stockItem['especificacion'])}`.trim()
      : text(movement['detalle']);
    const row: ReportRow = {
      registro: 'Movimiento',
      fecha: reportValue(movement['fecha']),
      sede: siteName(siteId, sites),
      sedeDestino: destinationId ? siteName(destinationId, sites) : '',
      tipo: movementType,
      producto: product,
      disponible: null,
      minimo: null,
      cantidad: typeof movement['cantidad'] === 'number' ? movement['cantidad'] : null,
      operador: text(movement['operador']),
      detalle: text(movement['detalle']),
      _siteId: siteId,
      _destinationId: destinationId,
      _state: '',
    };
    const siteMatches =
      !filters.site || siteId === filters.site || destinationId === filters.site;
    if (
      siteMatches &&
      (!filters.type ||
        row['tipo'] === filters.type ||
        text(stockItem?.['tipo']) === filters.type) &&
      !filters.state &&
      (!filters.operator || textMatches(row['operador'], filters.operator)) &&
      dateMatches(row['fecha'], filters.from, filters.to) &&
      textMatches(reportSearchText(row), filters.search)
    ) {
      rows.push(row);
    }
  }

  const clean = rows.map(
    ({ _siteId: _site, _destinationId: _destination, _state: _state, ...row }) => row,
  );
  return {
    items: includeAll ? clean : paginateArray(clean, page, 'fecha', filters.sort),
    total: clean.length,
    locations,
  };
}

function appendFilter(
  values: unknown[],
  clauses: string[],
  sql: (placeholder: string) => string,
  value: unknown,
): void {
  values.push(value);
  clauses.push(sql(`$${values.length}`));
}

async function querySqlReport(
  pool: Pool,
  select: string,
  from: string,
  clauses: string[],
  values: unknown[],
  page: PageOptions,
  includeAll: boolean,
  orderBy: string,
  direction: 'newest' | 'oldest',
): Promise<{ items: ReportRow[]; total: number }> {
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const [count, rows] = await Promise.all([
    pool.query<{ total: number }>(`SELECT count(*)::int AS total ${from} ${where}`, values),
    pool.query<Record<string, unknown>>(
      `SELECT ${select}
       ${from}
       ${where}
       ORDER BY ${orderBy} ${direction === 'newest' ? 'DESC' : 'ASC'}
       ${includeAll ? '' : `LIMIT $${values.length + 1} OFFSET $${values.length + 2}`}`,
      includeAll ? values : [...values, page.pageSize, page.offset],
    ),
  ]);
  return {
    items: rows.rows.map((row) =>
      Object.fromEntries(Object.entries(row).map(([key, value]) => [key, reportValue(value)])),
    ),
    total: count.rows[0]?.total ?? 0,
  };
}

async function createSqlReport(
  pool: Pool,
  reportId: 'transfers' | 'tickets' | 'tasks' | 'activity',
  filters: ReportFilters,
  page: PageOptions,
  includeAll: boolean,
): Promise<{ items: ReportRow[]; total: number }> {
  const values: unknown[] = [];
  const clauses: string[] = [];
  const bind = (value: unknown, clause: (placeholder: string) => string): void =>
    appendFilter(values, clauses, clause, value);
  const direction = filters.sort;

  if (reportId === 'tasks') {
    const from = `FROM gestion_it.operator_tasks AS task
      JOIN gestion_it.sedes AS sede ON sede.id = task.sede_id
      JOIN gestion_it.app_users AS actor ON actor.id = task.operator_id
      LEFT JOIN gestion_it.areas AS area ON area.id = task.area_id`;
    if (filters.site) bind(filters.site, (p) => `task.sede_id = ${p}::uuid`);
    if (filters.area) bind(filters.area, (p) => `area.nombre ILIKE '%' || ${p} || '%'`);
    if (filters.operator) bind(filters.operator, (p) => `actor.username ILIKE '%' || ${p} || '%'`);
    if (filters.from) bind(filters.from, (p) => `task.performed_at >= ${p}::date`);
    if (filters.to) bind(filters.to, (p) => `task.performed_at < ${p}::date + interval '1 day'`);
    if (filters.type) bind(filters.type, (p) => `task.tipo = ${p}`);
    if (filters.search) {
      bind(
        filters.search,
        (p) =>
          `(task.titulo ILIKE '%' || ${p} || '%'
            OR task.descripcion ILIKE '%' || ${p} || '%'
            OR task.tipo ILIKE '%' || ${p} || '%'
            OR task.observations ILIKE '%' || ${p} || '%'
            OR task.related_asset_type ILIKE '%' || ${p} || '%'
            OR task.related_asset_id ILIKE '%' || ${p} || '%'
            OR area.nombre ILIKE '%' || ${p} || '%'
            OR actor.username ILIKE '%' || ${p} || '%')`,
      );
    }
    return querySqlReport(
      pool,
      `task.performed_at AS fecha, task.created_at AS registrada,
       sede.nombre AS sede, area.nombre AS area, task.tipo AS tipo,
       task.titulo AS tarea, task.descripcion AS detalle, actor.username AS operador,
       task.observations AS observaciones,
       task.related_asset_type AS "relatedAssetType",
       task.related_asset_id AS "relatedAssetId",
       task.duracion_minutos AS "duracionMinutos"`,
      from,
      clauses,
      values,
      page,
      includeAll,
      'task.performed_at',
      direction,
    );
  }

  if (reportId === 'tickets') {
    const from = `FROM gestion_it.tickets AS ticket
      JOIN gestion_it.app_users AS requester ON requester.id = ticket.usuario_id
      LEFT JOIN gestion_it.areas AS area ON area.id = ticket.area_id
      LEFT JOIN gestion_it.sedes AS site ON site.id = ticket.sede_id`;
    if (filters.site) bind(filters.site, (p) => `ticket.sede_id = ${p}::uuid`);
    if (filters.area) bind(filters.area, (p) => `area.nombre ILIKE '%' || ${p} || '%'`);
    if (filters.operator) bind(filters.operator, (p) => `requester.username ILIKE '%' || ${p} || '%'`);
    if (filters.from) bind(filters.from, (p) => `ticket.fecha_creacion >= ${p}::date`);
    if (filters.to) bind(filters.to, (p) => `ticket.fecha_creacion < ${p}::date + interval '1 day'`);
    if (filters.state) bind(filters.state, (p) => `ticket.estado = ${p}`);
    if (filters.category) bind(filters.category, (p) => `ticket.categoria = ${p}`);
    if (filters.search) {
      bind(
        filters.search,
        (p) =>
          `(ticket.titulo ILIKE '%' || ${p} || '%'
            OR ticket.descripcion ILIKE '%' || ${p} || '%'
            OR ticket.categoria ILIKE '%' || ${p} || '%'
            OR ticket.estado ILIKE '%' || ${p} || '%'
            OR requester.username ILIKE '%' || ${p} || '%'
            OR area.nombre ILIKE '%' || ${p} || '%'
            OR site.nombre ILIKE '%' || ${p} || '%'
            OR ticket.nombre_afectado ILIKE '%' || ${p} || '%')`,
      );
    }
    return querySqlReport(
      pool,
      `ticket.fecha_creacion AS fecha, site.nombre AS sede, area.nombre AS area,
       ticket.estado AS estado, ticket.categoria AS categoria, ticket.titulo AS asunto,
       ticket.descripcion AS descripcion, requester.username AS solicitante,
       ticket.nombre_afectado AS afectado, ticket.solucion AS solucion`,
      from,
      clauses,
      values,
      page,
      includeAll,
      'ticket.fecha_creacion',
      direction,
    );
  }

  if (reportId === 'transfers') {
    const from = `FROM gestion_it.inventory_transfers AS transfer
      JOIN gestion_it.app_users AS actor ON actor.id = transfer.created_by
      JOIN gestion_it.inventory_transfer_movements AS movement
        ON movement.transfer_id = transfer.id
      LEFT JOIN gestion_it.areas AS origin_area
        ON origin_area.inventory_area_id = movement.origin->>'areaId'
      LEFT JOIN gestion_it.sedes AS origin_site ON origin_site.id = origin_area.sede_id
      LEFT JOIN gestion_it.areas AS destination_area
        ON destination_area.inventory_area_id = movement.destination->>'areaId'
      LEFT JOIN gestion_it.sedes AS destination_site ON destination_site.id = destination_area.sede_id`;
    if (filters.site) {
      bind(filters.site, (p) => `(origin_site.id = ${p}::uuid OR destination_site.id = ${p}::uuid)`);
    }
    if (filters.area) {
      bind(
        filters.area,
        (p) =>
          `(origin_area.nombre ILIKE '%' || ${p} || '%'
            OR destination_area.nombre ILIKE '%' || ${p} || '%')`,
      );
    }
    if (filters.operator) bind(filters.operator, (p) => `actor.username ILIKE '%' || ${p} || '%'`);
    if (filters.from) bind(filters.from, (p) => `transfer.created_at >= ${p}::date`);
    if (filters.to) bind(filters.to, (p) => `transfer.created_at < ${p}::date + interval '1 day'`);
    if (filters.type) bind(filters.type, (p) => `movement.entity_type = ${p}`);
    if (filters.search) {
      bind(
        filters.search,
        (p) =>
          `(transfer.description ILIKE '%' || ${p} || '%'
            OR actor.username ILIKE '%' || ${p} || '%'
            OR movement.entity_name ILIKE '%' || ${p} || '%'
            OR movement.entity_type ILIKE '%' || ${p} || '%')`,
      );
    }
    return querySqlReport(
      pool,
      `transfer.created_at AS fecha, actor.username AS responsable,
       movement.entity_type AS tipo, movement.entity_name AS elemento,
       transfer.description AS motivo, origin_site.nombre AS "sedeOrigen",
       origin_area.nombre AS "areaOrigen", movement.origin->>'workstationId' AS "puestoOrigen",
       destination_site.nombre AS "sedeDestino", destination_area.nombre AS "areaDestino",
       movement.destination->>'workstationId' AS "puestoDestino"`,
      from,
      clauses,
      values,
      page,
      includeAll,
      'transfer.created_at',
      direction,
    );
  }

  const from = 'FROM gestion_it.operator_audit_events AS event';
  if (filters.operator) bind(filters.operator, (p) => `event.actor_username ILIKE '%' || ${p} || '%'`);
  if (filters.from) bind(filters.from, (p) => `event.created_at >= ${p}::date`);
  if (filters.to) bind(filters.to, (p) => `event.created_at < ${p}::date + interval '1 day'`);
  if (filters.module) bind(filters.module, (p) => `event.entity_type ILIKE '%' || ${p} || '%'`);
  if (filters.action) bind(filters.action, (p) => `event.action ILIKE '%' || ${p} || '%'`);
  if (filters.search) {
    bind(
      filters.search,
      (p) =>
        `(event.actor_username ILIKE '%' || ${p} || '%'
          OR event.action ILIKE '%' || ${p} || '%'
          OR event.entity_type ILIKE '%' || ${p} || '%'
          OR COALESCE(event.entity_id, '') ILIKE '%' || ${p} || '%'
          OR COALESCE(event.entity_name, '') ILIKE '%' || ${p} || '%'
          OR event.details::text ILIKE '%' || ${p} || '%')`,
    );
  }
  const data = await querySqlReport(
    pool,
    `event.created_at AS fecha, event.actor_username AS operador,
     event.entity_type AS modulo, event.action AS accion,
     COALESCE(event.entity_name, event.entity_id, '') AS elemento,
     event.details->>'resultado' AS resultado,
     event.details::text AS detalle`,
    from,
    clauses,
    values,
    page,
    true,
    'event.created_at',
    direction,
  );
  const [snapshot, firstAuditEvent] = await Promise.all([
    pool.query<{ history: unknown }>(
      `SELECT payload->'historial' AS history
       FROM gestion_it.inventory_snapshot
       WHERE singleton_id = true`,
    ),
    pool.query<{ first_created_at: Date | null }>(
      'SELECT min(created_at) AS first_created_at FROM gestion_it.operator_audit_events',
    ),
  ]);
  const auditStartedAt = firstAuditEvent.rows[0]?.first_created_at?.toISOString() ?? null;
  const fallbackHistory = await excludeAuditedStockMovementHistory(
    pool,
    inventoryHistoryAuditEvents(snapshot.rows[0]?.history)
      .filter(
        (event) =>
          (!auditStartedAt || event.createdAt < auditStartedAt) &&
          textMatches(event.actorUsername, filters.operator) &&
          dateMatches(event.createdAt, filters.from, filters.to) &&
          textMatches(event.entityType, filters.module) &&
          textMatches(event.action, filters.action) &&
          textMatches(
            [
              event.actorUsername,
              event.action,
              event.entityType,
              event.entityId ?? '',
              event.entityName ?? '',
              JSON.stringify(event.details),
            ].join(' '),
            filters.search,
          ),
      ),
  );
  const fallback = fallbackHistory.map((event) => ({
    fecha: event.createdAt,
    operador: event.actorUsername,
    modulo: event.entityType,
    accion: event.action,
    elemento: event.entityName ?? event.entityId ?? '',
    resultado: null,
    detalle: JSON.stringify(event.details),
  }));
  const ordered = [...data.items, ...fallback].sort((left, right) => {
    const comparison = String(left['fecha']).localeCompare(String(right['fecha']));
    return direction === 'newest' ? -comparison : comparison;
  });
  return {
    items: includeAll ? ordered : ordered.slice(page.offset, page.offset + page.pageSize),
    total: data.total + fallback.length,
  };
}

async function createTransfersReport(
  pool: Pool,
  filters: ReportFilters,
  page: PageOptions,
  includeAll: boolean,
): Promise<{ items: ReportRow[]; total: number }> {
  const assets =
    filters.type === 'STOCK'
      ? { items: [] as ReportRow[], total: 0 }
      : await createSqlReport(pool, 'transfers', filters, page, true);
  const [snapshotResult, locations] = await Promise.all([
    pool.query<{ payload: unknown }>(
      'SELECT payload FROM gestion_it.inventory_snapshot WHERE singleton_id = true',
    ),
    loadLocations(pool),
  ]);
  const payload = snapshotResult.rows[0]?.payload;
  const stockById = new Map(
    getSnapshotRows(payload, 'stock').map((item) => [text(item['id']), item]),
  );
  const stockTransfers: ReportRow[] = [];

  if (!filters.type || filters.type === 'STOCK') {
    for (const movement of getSnapshotRows(payload, 'historial')) {
      if (movement['tipo'] !== 'TRANSFERENCIA_STOCK') continue;
      const sourceId = text(movement['sedeId']);
      const destinationId = text(movement['sedeDestinoId']);
      const operator = text(movement['operador']);
      const stockItem = stockById.get(text(movement['insumoId']));
      const product = stockItem
        ? `${text(stockItem['tipo'])} ${text(stockItem['marca'])} ${text(stockItem['especificacion'])}`.trim()
        : text(movement['detalle']);
      const row: ReportRow = {
        fecha: reportValue(movement['fecha']),
        responsable: operator,
        tipo: 'STOCK',
        elemento: product,
        cantidad: typeof movement['cantidad'] === 'number' ? movement['cantidad'] : null,
        motivo: text(movement['detalle']),
        sedeOrigen: sourceId ? siteName(sourceId, locations.sitesById) : '',
        areaOrigen: '',
        puestoOrigen: '',
        sedeDestino: destinationId ? siteName(destinationId, locations.sitesById) : '',
        areaDestino: '',
        puestoDestino: '',
        _sourceId: sourceId,
        _destinationId: destinationId,
      };
      const matchesSite =
        !filters.site || sourceId === filters.site || destinationId === filters.site;
      if (
        matchesSite &&
        !filters.area &&
        (!filters.operator || textMatches(operator, filters.operator)) &&
        dateMatches(row['fecha'], filters.from, filters.to) &&
        textMatches(reportSearchText(row), filters.search)
      ) {
        stockTransfers.push(row);
      }
    }
  }

  const combined = [...assets.items, ...stockTransfers].map(
    ({ _sourceId: _source, _destinationId: _destination, ...row }) => row,
  );
  const sorted = combined.sort((left, right) => {
    const comparison = String(left['fecha'] ?? '').localeCompare(String(right['fecha'] ?? ''));
    return filters.sort === 'newest' ? -comparison : comparison;
  });
  return {
    items: includeAll ? sorted : sorted.slice(page.offset, page.offset + page.pageSize),
    total: assets.total + stockTransfers.length,
  };
}

async function loadReport(
  pool: Pool,
  reportId: ReportId,
  filters: ReportFilters,
  page: PageOptions,
  includeAll: boolean,
): Promise<ReportData> {
  const definition = reportDefinitions[reportId];
  const generatedAt = new Date().toISOString();
  let items: ReportRow[];
  let total: number;
  let locations: Awaited<ReturnType<typeof loadLocations>> | null = null;
  if (reportId === 'inventory' || reportId === 'stock') {
    const result = await createArrayReport(pool, reportId, filters, page, includeAll);
    items = result.items;
    total = result.total;
    locations = result.locations;
  } else if (reportId === 'transfers') {
    const result = await createTransfersReport(pool, filters, page, includeAll);
    items = result.items;
    total = result.total;
  } else {
    const result = await createSqlReport(pool, reportId, filters, page, includeAll);
    items = result.items;
    total = result.total;
  }
  locations ??= await loadLocations(pool);
  return {
    title: definition.title,
    columns: definition.columns,
    items,
    total,
    page: includeAll ? 1 : page.page,
    pageSize: includeAll ? total : page.pageSize,
    generatedAt,
    criteria: criteriaFor(filters, locations.sitesById, reportId),
  };
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function filename(reportId: ReportId): string {
  return `gestion-stock-it-${reportId}-${new Date().toISOString().slice(0, 10)}`;
}

function sendExcel(response: express.Response, report: ReportData, reportId: ReportId): void {
  const workbook = XLSX.utils.book_new();
  const criteriaRows: (string | number)[][] = [
    ['Reporte', report.title],
    ['Generado', report.generatedAt],
    ['Resultados', report.total],
    ...report.criteria.map((criterion) => [criterion.label, criterion.value]),
  ];
  const criteriaSheet = XLSX.utils.aoa_to_sheet(criteriaRows);
  const dataSheet = XLSX.utils.aoa_to_sheet([
    report.columns.map((column) => column.label),
    ...report.items.map((item) => report.columns.map((column) => item[column.key] ?? '')),
  ]);
  criteriaSheet['!cols'] = [{ wch: 28 }, { wch: 60 }];
  dataSheet['!cols'] = report.columns.map((column) => ({
    wch: Math.min(Math.max(column.label.length + 2, 14), 50),
  }));
  if (report.items.length > 0) {
    dataSheet['!autofilter'] = {
      ref: XLSX.utils.encode_range({
        s: { r: 0, c: 0 },
        e: { r: report.items.length, c: report.columns.length - 1 },
      }),
    };
  }
  XLSX.utils.book_append_sheet(workbook, criteriaSheet, 'Criterios');
  XLSX.utils.book_append_sheet(workbook, dataSheet, reportDefinitions[reportId].sheet);
  const file = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });
  response
    .status(200)
    .set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename(reportId)}.xlsx"`,
    })
    .send(file);
}

function sendPrintPage(response: express.Response, report: ReportData, reportId: ReportId): void {
  const criteria = report.criteria.length
    ? report.criteria
        .map((criterion) => `<li><strong>${escapeHtml(criterion.label)}:</strong> ${escapeHtml(criterion.value)}</li>`)
        .join('')
    : '<li>Sin filtros adicionales</li>';
  const headers = report.columns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join('');
  const rows = report.items
    .map(
      (item) =>
        `<tr>${report.columns.map((column) => `<td>${escapeHtml(item[column.key])}</td>`).join('')}</tr>`,
    )
    .join('');
  const html = `<!doctype html>
    <html lang="es">
      <head>
        <meta charset="utf-8">
        <title>${escapeHtml(report.title)}</title>
        <style>
          body{font:12px Arial,sans-serif;color:#202a45;margin:24px}
          h1{font-size:20px;margin:0 0 8px}
          .meta{color:#596579;margin:4px 0}
          ul{display:flex;flex-wrap:wrap;gap:8px 24px;padding-left:18px}
          table{width:100%;border-collapse:collapse;margin-top:18px}
          th,td{border:1px solid #d5dce7;padding:6px;text-align:left;vertical-align:top}
          th{background:#26365b;color:white}
          tr:nth-child(even){background:#f3f6fb}
          @media print{body{margin:10mm}.no-print{display:none}thead{display:table-header-group}}
        </style>
      </head>
      <body>
        <button class="no-print" type="button" onclick="window.print()">Imprimir / Guardar como PDF</button>
        <h1>${escapeHtml(report.title)}</h1>
        <p class="meta">Generado: ${escapeHtml(report.generatedAt)} · ${report.total} resultados</p>
        <p><strong>Filtros aplicados</strong></p><ul>${criteria}</ul>
        <table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>
      </body>
    </html>`;
  response
    .status(200)
    .set({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': `inline; filename="${filename(reportId)}.html"`,
      'X-Content-Type-Options': 'nosniff',
    })
    .send(html);
}

export function createReportsApi(pool: Pool): express.Router {
  const router = express.Router();

  const authorizeReport = (request: express.Request, response: express.Response): ReportId | null => {
    const rawId = request.params['reportId'];
    if (typeof rawId !== 'string' || !isReportId(rawId)) {
      response.status(404).json({ error: 'El tipo de reporte solicitado no existe.' });
      return null;
    }
    if (rawId === 'activity' && request.session.user?.role !== 'admin') {
      response.status(403).json({ error: 'Solo una persona administradora puede consultar la auditoría.' });
      return null;
    }
    return rawId;
  };

  const readReportRequest = (
    request: express.Request,
    response: express.Response,
    includeAll: boolean,
  ): { reportId: ReportId; filters: ReportFilters; page: PageOptions } | null => {
    const reportId = authorizeReport(request, response);
    const filters = parseFilters(request.query);
    const page = parsePageOptions(request.query['page'], request.query['pageSize'], 25);
    if (!reportId) return null;
    if (!filters || page === null) {
      response.status(400).json({ error: 'Los filtros o la paginación del reporte no son válidos.' });
      return null;
    }
    return { reportId, filters, page: includeAll ? { ...page, page: 1, offset: 0 } : page };
  };

  router.get('/reports/:reportId/export.xlsx', requireReportAccess, async (request, response, next) => {
    const parsed = readReportRequest(request, response, true);
    if (!parsed) return;
    try {
      const report = await loadReport(pool, parsed.reportId, parsed.filters, parsed.page, true);
      sendExcel(response, report, parsed.reportId);
    } catch (error) {
      next(error);
    }
  });

  router.get('/reports/:reportId/print', requireReportAccess, async (request, response, next) => {
    const parsed = readReportRequest(request, response, true);
    if (!parsed) return;
    try {
      const report = await loadReport(pool, parsed.reportId, parsed.filters, parsed.page, true);
      sendPrintPage(response, report, parsed.reportId);
    } catch (error) {
      next(error);
    }
  });

  router.get('/reports/:reportId', requireReportAccess, async (request, response, next) => {
    const parsed = readReportRequest(request, response, false);
    if (!parsed) return;
    try {
      response.json(
        await loadReport(pool, parsed.reportId, parsed.filters, parsed.page, false),
      );
    } catch (error) {
      next(error);
    }
  });

  return router;
}
