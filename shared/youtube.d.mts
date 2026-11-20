export type YoutubeTarget = { video?: string; playlist?: string }

export function youtubeTarget(raw: unknown): YoutubeTarget | null
export function youtubeEmbed(target: YoutubeTarget | null, origin: string): string | null
export function youtubeWatch(target: YoutubeTarget | null): string | null
