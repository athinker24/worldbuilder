import { api, getLanguage } from './api'
import { confirmDialog } from './dialog'
import { translate } from './i18n'
import { pushUndo } from './undo'

/**
 * Confirm and delete an entity; captures full state for Ctrl+Z (row + links + map
 * feature bindings). Returns true when the deletion happened.
 */
export async function deleteEntityWithUndo(id: number): Promise<boolean> {
  const entity = await api.getEntity(id)
  if (!entity) return false
  const lang = await getLanguage()
  if (!(await confirmDialog(translate(lang, 'Delete "{name}"?', { name: entity.name }))))
    return false

  const links = [
    ...entity.outLinks.map((l) => ({
      from_id: id,
      to_id: l.to_id,
      relation: l.relation,
      notes: l.notes
    })),
    ...entity.inLinks.map((l) => ({
      from_id: l.from_id,
      to_id: id,
      relation: l.relation,
      notes: l.notes
    }))
  ]
  const featureIds = await api.entityFeatureIds(id)
  // restoreEntity restores under the same id; redo can delete that same id
  pushUndo({
    undo: () => api.restoreEntity(entity, links, featureIds),
    redo: () => api.deleteEntity(id)
  })
  await api.deleteEntity(id)
  return true
}

/**
 * Delete several entities with one confirm + one undo record. The restore order
 * (rows → links → features) lives in db.restoreEntities so a link between two deleted
 * entities cannot violate the FK. Returns true when the deletion happened.
 */
export async function deleteEntitiesWithUndo(ids: number[]): Promise<boolean> {
  if (!ids.length) return false
  const lang = await getLanguage()
  if (!(await confirmDialog(translate(lang, 'Delete {n} entities?', { n: ids.length }))))
    return false

  const rows: Parameters<typeof api.restoreEntities>[0] = []
  // A link between two deleted entities is captured from both sides — dedup by key
  const linkMap = new Map<
    string,
    { from_id: number; to_id: number; relation: string; notes: string }
  >()
  const features: { entity_id: number; feature_id: number }[] = []
  for (const id of ids) {
    const entity = await api.getEntity(id)
    if (!entity) continue
    const { name, content, fields, created_at } = entity
    rows.push({ id, name, content, fields, created_at })
    for (const l of entity.outLinks) {
      const rec = { from_id: id, to_id: l.to_id, relation: l.relation, notes: l.notes }
      linkMap.set(`${rec.from_id}|${rec.to_id}|${rec.relation}|${rec.notes}`, rec)
    }
    for (const l of entity.inLinks) {
      const rec = { from_id: l.from_id, to_id: id, relation: l.relation, notes: l.notes }
      linkMap.set(`${rec.from_id}|${rec.to_id}|${rec.relation}|${rec.notes}`, rec)
    }
    for (const fid of await api.entityFeatureIds(id))
      features.push({ entity_id: id, feature_id: fid })
  }
  const links = [...linkMap.values()]
  pushUndo({
    undo: () => api.restoreEntities(rows, links, features),
    redo: async () => {
      for (const id of ids) await api.deleteEntity(id)
    }
  })
  for (const id of ids) await api.deleteEntity(id)
  return true
}
