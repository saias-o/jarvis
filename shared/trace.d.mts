export const TRACE_FILE_BYTES: number
export const TRACE_FILES: number
export type Trace = (event: string, data?: Record<string, unknown>) => unknown
export type TraceLogger = { record: Trace; child(context: Record<string, unknown>): TraceLogger; flush(): Promise<void> }
export function traceData(value: unknown): any
export function createTrace(options: { write(line: string): unknown; context?: Record<string, unknown>; now?: () => Date; onError?: (error: unknown) => void }): TraceLogger
