/** `bot` namespace dictionaries for the status strip. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'label.bot': '机器人',
  'label.tickets': '工单',
  'label.needs': '待处理',
} satisfies Record<string, string>

/** The bot namespace key union. */
export type BotKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'label.bot': 'Bot',
  'label.tickets': 'Tickets',
  'label.needs': 'Need you',
} satisfies Record<BotKey, string>

/** Japanese dictionary. */
export const ja = {
  'label.bot': 'ボット',
  'label.tickets': 'チケット',
  'label.needs': '対応待ち',
} satisfies Record<BotKey, string>

/** Spanish dictionary. */
export const es = {
  'label.bot': 'Bot',
  'label.tickets': 'Tareas',
  'label.needs': 'Requiere tu atención',
} satisfies Record<BotKey, string>

/** French dictionary. */
export const fr = {
  'label.bot': 'Bot',
  'label.tickets': 'Tâches',
  'label.needs': 'À traiter',
} satisfies Record<BotKey, string>

/** German dictionary. */
export const de = {
  'label.bot': 'Bot',
  'label.tickets': 'Tickets',
  'label.needs': 'Handlungsbedarf',
} satisfies Record<BotKey, string>

/** Russian dictionary. */
export const ru = {
  'label.bot': 'Бот',
  'label.tickets': 'Задачи',
  'label.needs': 'Нужно внимание',
} satisfies Record<BotKey, string>

/** Portuguese dictionary. */
export const pt = {
  'label.bot': 'Bot',
  'label.tickets': 'Tarefas',
  'label.needs': 'Precisa de você',
} satisfies Record<BotKey, string>
