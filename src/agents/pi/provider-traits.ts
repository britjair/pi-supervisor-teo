// Свойства провайдеров Pi, важные для Teo (docs/08-model-profiles.md §5.5).
//
// Сессии supervisor-а Teo создаются через SDK и всегда без расширений
// (`noExtensions` для роли supervisor в pi-agent-runtime.openSession): supervisor оценивает
// работу агентов и не должен зависеть от пользовательских расширений Pi.
//
// Большинство провайдеров это не трогает: они берут системный промпт из контекста запроса
// (так работает pi-antigravity) и одинаково обслуживают любую сессию. Но провайдер может быть
// реализован как мост, которому нужен хук в самой вызывающей сессии. Такой провайдер не может
// обслужить supervisor никогда, и узнать это по факту разрешения модели нельзя — ошибка приходит
// только во время хода.

/**
 * Провайдеры, которым нужен их собственный хук внутри вызывающей сессии.
 *
 * `claude-bridge` проксирует запрос в Claude Code и проецирует туда системный промпт,
 * записанный его хуком `before_agent_start`. Хранилище капч process-global, но наполняют его
 * только сессии, где расширение загружено. У сессии supervisor-а расширений нет, поэтому капчи
 * для её промпта не существует и мост отказывается работать с ошибкой `prompt-capture: no capture`.
 * Для ролей этапов тот же провайдер работает штатно: они идут в пользовательской сессии Pi,
 * где `before_agent_start` срабатывает.
 */
export const PROVIDERS_NEEDING_SESSION_EXTENSION: readonly string[] = ["claude-bridge"];

/** Может ли провайдер обслужить сессию без расширений (supervisor Teo). */
export function servesExtensionlessSession(provider: string): boolean {
  return !PROVIDERS_NEEDING_SESSION_EXTENSION.includes(provider.toLowerCase());
}

/** `provider` из `provider/model`. */
export function providerOf(modelId: string): string {
  return modelId.split("/")[0] ?? "";
}
