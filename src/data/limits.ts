export const MAX_TITLE_LENGTH = 255
export const MAX_FOLDER_NAME_LENGTH = 255

export function checkedTitle(title: string): string {
  if (title.length > MAX_TITLE_LENGTH) throw new Error(`便签标题最多 ${MAX_TITLE_LENGTH} 个字符`)
  return title
}

export function checkedFolderName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('请输入文件夹名称')
  if (trimmed.length > MAX_FOLDER_NAME_LENGTH) throw new Error(`文件夹名称最多 ${MAX_FOLDER_NAME_LENGTH} 个字符`)
  return trimmed
}

export function titleWithSuffix(title: string, suffix: string): string {
  const base = title || '无标题'
  return base.length + suffix.length <= MAX_TITLE_LENGTH ? `${base}${suffix}` : base
}

