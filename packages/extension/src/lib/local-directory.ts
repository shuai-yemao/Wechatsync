import { LOCAL_LIMITS, type LocalFile } from './local-document'
import { isImportFile } from './local-batch'

export interface ImportDirectory {
  readonly name: string
  readonly kind: 'directory'
  values(): AsyncIterable<ImportDirectory | ImportFileHandle>
}
interface ImportFileHandle {
  readonly name: string
  readonly kind: 'file'
  getFile(): Promise<File>
}

export function directoryPicker(): ((options: { mode: 'read'; id: string }) => Promise<ImportDirectory>) | undefined {
  return (window as unknown as { showDirectoryPicker?: (options: { mode: 'read'; id: string }) => Promise<ImportDirectory> }).showDirectoryPicker?.bind(window)
}

/** Retain read-only file references, not expanded image bodies or filesystem handles. */
export async function readImportDirectory(directory: ImportDirectory): Promise<LocalFile[]> {
  const files: LocalFile[] = []
  let entries = 0, bytes = 0
  const walk = async (current: ImportDirectory, path: string, depth: number): Promise<void> => {
    if (depth > 32) throw new Error('目录层级超过 32 层，请选择更具体的文件夹')
    for await (const entry of current.values()) {
      if (++entries > 5000) throw new Error('目录条目超过 5000 个，请选择更具体的文件夹')
      if (entry.kind === 'directory') {
        await walk(entry, `${path}/${entry.name}`, depth + 1)
      } else {
        if (!isImportFile({ name: entry.name } as LocalFile)) continue
        const file = await entry.getFile()
        bytes += file.size
        if (bytes > LOCAL_LIMITS.total) throw new Error('目录中的文档与图片超过 50 MiB，请选择更具体的文件夹')
        files.push({ name: file.name, size: file.size, type: file.type, webkitRelativePath: `${path}/${file.name}`, text: () => file.text(), arrayBuffer: () => file.arrayBuffer() })
      }
    }
  }
  await walk(directory, directory.name, 0)
  return files
}
