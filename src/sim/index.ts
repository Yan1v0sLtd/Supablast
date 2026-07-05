/**
 * /sim — pure TypeScript simulation package (GDD §9).
 * LAW: zero Phaser/DOM dependencies. Everything here runs identically
 * headless in Node (CI, server verification, tuning) and in the browser.
 */
export * from './types';
export * from './tuning';
export * from './prng';
export { generateBoard } from './generator';
export { simulate, drawOutcomes, canonicalOutcomes } from './engine';
export { auditBoard, type BoardAudit, type SocketAudit } from './audit';
export {
  applyTools,
  boardDistance,
  toolCost,
  toolsCost,
  validateTools,
  type ToolPlacement,
  type ToolValidation,
} from './tools';
