import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import Player from '../miao-plugin/models/Player.js'
import { Common, Meta, Format } from '../miao-plugin/components/index.js'
import { Artifact, Avatar, Character, MysApi, Weapon } from '../miao-plugin/models/index.js'
import ArtisMarkCfg from '../miao-plugin/models/artis/ArtisMarkCfg.js'

const BACKUP_DIR = path.join(process.cwd(), 'data', 'PlayerData', 'backups')

try {
  fs.mkdirSync(BACKUP_DIR, { recursive: true })
} catch (e) {
  /* ignore */
}

const _save = Player.prototype.save
const lastBackupInfo = new Map()

Player.prototype.save = function (flag = null) {
  let ret = _save.call(this, flag)

  if (flag === false || this._save === false) {
    return ret
  }

  if (!this.e || !this.uid) {
    return ret
  }

  let src = path.join(process.cwd(), this._file)
  if (!fs.existsSync(src)) {
    return ret
  }

  try {
    let content = fs.readFileSync(src)
    let hash = crypto.createHash('md5').update(content).digest('hex')
    let prev = lastBackupInfo.get(this.uid)
    if (prev && prev.hash === hash && Date.now() - prev.time < 5000) {
      return ret
    }

    let ts = Date.now()
    let name = path.basename(src, '.json')
    let dst = path.join(BACKUP_DIR, `${name}_${ts}.bak`)
    fs.copyFileSync(src, dst)

    lastBackupInfo.set(this.uid, { hash, time: ts })
  } catch (e) {
    console.error('[auto_backup]', e)
  }

  return ret
}

async function getUid (e, game) {
  let prev = { game: e.game, isSr: e.isSr }
  if (game) { e.game = game; e.isSr = game === 'sr' }
  try {
    let user = await MysApi.initUser(e)
    if (user?.uid) return user.uid
  } catch (_) {}
  finally { e.game = prev.game; e.isSr = prev.isSr }
  return null
}

function avatarHash (avatarData) {
  let artis = avatarData?.artis || {}
  let weapon = avatarData?.weapon || {}
  let talent = avatarData?.talent || {}
  let cons = avatarData?.cons || 0
  let level = avatarData?.level || 0
  let sig = JSON.stringify({ artis, weapon, talent, cons, level })
  return crypto.createHash('md5').update(sig).digest('hex')
}

function getChar (name, preferGame) {
  if (preferGame === 'sr') {
    return Character.get(name, 'sr') || Character.get(name, 'gs')
  }
  return Character.get(name, 'gs') || Character.get(name, 'sr')
}

function formatTime (ts) {
  let d = new Date(Number(ts))
  let pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export class auto_backup extends plugin {
  constructor() {
    super({
      name: 'AutoBackup',
      dsc: 'PlayerData 增量备份与备份查看',
      event: 'message',
      priority: 0,
      rule: [
        {
          reg: '^#(.+)面板备份列表(\\d*)$',
          fnc: 'backupList'
        },
        {
          reg: '^#(.+)面板备份(\\d*)$',
          fnc: 'backupArtis'
        }
      ]
    })
  }

  async getBackupFiles (uid) {
    if (!fs.existsSync(BACKUP_DIR)) return []
    return fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith(uid + '_') && f.endsWith('.bak'))
      .sort()
      .reverse()
  }

  async buildProfileDetail (avatar, char, uid, game) {
    let data = avatar.getData('name,abbr,cons,level,talent,dataSource,updateTime,imgs,costumeSplash')
    data.weapon = avatar.getWeaponDetail()

    let a = avatar.attr
    let base = avatar.base
    let attr = {}
    let intKeys = ['hp']

    let gsKeys = ['hp', 'def', 'atk', 'mastery']
    let srKeys = ['hp', 'def', 'atk', 'speed']
    let keys = game === 'sr' ? srKeys : gsKeys
    keys.forEach(key => {
      let fix = intKeys.includes(key) ? 0 : 1
      attr[key] = Format.comma(a[key], fix)
      attr[`${key}Base`] = Format.comma(base[key], fix)
      attr[`${key}Plus`] = Format.comma(a[key] - base[key], fix)
    })

    let pctKeysGs = ['cpct', 'cdmg', 'recharge', 'dmg']
    let pctKeysSr = ['cpct', 'cdmg', 'dmg', 'stance', 'effPct', 'effDef', 'heal']
    let pctKeys = game === 'sr' ? pctKeysSr : pctKeysGs
    pctKeys.forEach(key => {
      let key2 = key
      if (key === 'dmg' && a.phy > a.dmg) {
        key2 = 'phy'
      }
      attr[key] = Format.pct(a[key2])
      attr[`${key}Base`] = Format.pct(base[key2])
      attr[`${key}Plus`] = Format.pct(a[key2] - base[key2])
    })

    if (game === 'sr') {
      attr['joy'] = Format.pct(a.joy || 0)
      attr['joyBase'] = Format.pct(base.joy || 0)
      attr['joyPlus'] = Format.pct((a.joy || 0) - (base.joy || 0))
    }

    let artisDetail = avatar.getArtisMark()
    let allAttr = avatar.artis.getAllAttr() || []
    allAttr = allAttr.slice(0, 9)
    for (let idx = allAttr.length; idx < 9; idx++) {
      allAttr[idx] = {}
    }
    artisDetail.allAttr = allAttr

    let artisKeyTitle = Artifact.getArtisKeyTitle(game)
    let wCfg = {}
    let weaponData = Weapon.get(avatar.weapon?.name, game)
    if (weaponData && avatar.weapon) {
      let wAttr = weaponData.calcAttr(avatar.weapon.level, avatar.weapon.promote)
      wCfg.weapons = [{
        name: avatar.weapon.name,
        level: avatar.weapon.level,
        promote: avatar.weapon.promote,
        affix: avatar.weapon.affix,
        attrs: wAttr
      }]
    }

    let enemyLv = game === 'sr' ? 80 : 103
    let dmgCalc = {}
    try {
      dmgCalc = await avatar.calcDmg({ enemyLv, mode: 'profile' })
      if (dmgCalc && dmgCalc.ret) {
        let dmgMsg = []
        let dmgData = []
        for (let ds of dmgCalc.ret) {
          if (ds.type !== 'text') {
            ds.dmg = Format.comma(ds.dmg, 0)
            ds.avg = Format.comma(ds.avg, 0)
          }
          dmgData.push(ds)
        }
        for (let msg of (dmgCalc.msg || [])) {
          dmgMsg.push(msg.replace(':', '：').split('：'))
        }
        dmgCalc.dmgMsg = dmgMsg
        dmgCalc.dmgData = dmgData
      }
    } catch (_) {}

    return {
      save_id: uid,
      uid,
      game,
      data,
      attr,
      elem: char.elem,
      dmgCalc,
      artisDetail,
      artisKeyTitle,
      bodyClass: `char-${char.name}`,
      mode: 'profile',
      wCfg
    }
  }

  async backupArtis () {
    let e = this.e
    let m = e.msg.match(/^#(.+)面板备份(\d*)$/)
    let rawName = m?.[1]
    let backupIdx = m?.[2] ? parseInt(m[2]) : 0
    if (!rawName) return false

    let preferGame
    if (rawName.startsWith('星铁')) {
      preferGame = 'sr'
      rawName = rawName.replace(/^星铁/, '')
    }
    let charName = rawName

    let char = getChar(charName, preferGame)
    if (!char) {
      e.reply(`未找到角色：${charName}`)
      return true
    }

    let game = char.isSr ? 'sr' : 'gs'

    let uid = await getUid(e, game)
    if (!uid) {
      e.reply('请先绑定UID（#绑定+你的UID）')
      return true
    }

    let files = await this.getBackupFiles(uid)
    if (!files.length) {
      e.reply('暂无该UID的备份数据，请先使用 #更新面板 后重试')
      return true
    }

    let idx = backupIdx > 0 ? backupIdx - 1 : 0
    if (idx >= files.length) {
      e.reply(`备份序号超出范围（共 ${files.length} 份）`)
      return true
    }

    let backupPath = path.join(BACKUP_DIR, files[idx])
    let backupData = JSON.parse(fs.readFileSync(backupPath, 'utf-8'))

    let charId = String(char.id)
    let avatarData = backupData.avatars?.[charId]
    if (!avatarData) {
      e.reply(`备份中未找到${charName}的数据`)
      return true
    }

    let avatar = new Avatar(avatarData, game)
    if (!avatar.hasData) {
      e.reply('备份数据不完整')
      return true
    }

    let renderData = await this.buildProfileDetail(avatar, char, uid, game)

    let img = await Common.render('character/profile-detail', renderData, { e, scale: 1.6, retType: 'base64' })

    e.reply(img)
    return true
  }

  async backupList () {
    let e = this.e
    let m = e.msg.match(/^#(.+)面板备份列表(\d*)$/)
    let rawName = m?.[1]
    if (!rawName) return false
    let listLimit = m?.[2] ? parseInt(m[2]) : 10

    let preferGame
    if (rawName.startsWith('星铁')) {
      preferGame = 'sr'
      rawName = rawName.replace(/^星铁/, '')
    }
    let charName = rawName

    let char = getChar(charName, preferGame)
    if (!char) {
      e.reply(`未找到角色：${charName}`)
      return true
    }

    let game = char.isSr ? 'sr' : 'gs'

    let uid = await getUid(e, game)
    if (!uid) {
      e.reply('请先绑定UID（#绑定+你的UID）')
      return true
    }

    let files = await this.getBackupFiles(uid)
    if (!files.length) {
      e.reply('暂无该UID的备份数据')
      return true
    }

    let charId = String(char.id)
    let limit = Math.min(files.length, listLimit)
    let gameLabel = game === 'sr' ? '星铁' : '原神'
    let lines = [`${charName} 面板备份列表 ${gameLabel} (最近${limit}次, 时间倒序):`, '']

    // First pass: collect hashes and time strings
    let items = []
    for (let i = 0; i < limit; i++) {
      let f = files[i]
      let tsMatch = f.match(/_(\d+)\.bak$/)
      let ts = tsMatch ? tsMatch[1] : '0'
      let timeStr = formatTime(ts)
      let backupPath = path.join(BACKUP_DIR, f)
      let data = JSON.parse(fs.readFileSync(backupPath, 'utf-8'))
      let avatarData = data.avatars?.[charId]
      let hash = avatarData ? avatarHash(avatarData) : null
      items.push({ timeStr, hash })
    }

    // Second pass: determine labels
    // Pairwise comparison: if newer (i) ≠ older (i+1), label goes on newer (i)
    for (let i = 0; i < items.length; i++) {
      let changed = ''

      if (i === 0) {
        // Newest vs live data
        let livePath = path.join(process.cwd(), 'data', 'PlayerData', game, `${uid}.json`)
        try {
          let liveData = JSON.parse(fs.readFileSync(livePath, 'utf-8'))
          let liveAv = liveData.avatars?.[charId]
          let liveHash = liveAv ? avatarHash(liveAv) : null
          changed = (items[0].hash === liveHash) ? ' (同当前面板)' : ' (有变化)'
        } catch (_) {
          changed = ' (无法对比当前面板)'
        }
      }

      // Compare with next (older) backup — label on newer one of the pair
      let next = items[i + 1]
      if (next && items[i].hash !== next.hash) {
        if (i > 0) changed = ' (有变化)'
      } else if (i > 0) {
        changed = ' (无变化)'
      }

      lines.push(`${i + 1}. ${items[i].timeStr}${changed}`)
    }

    lines.push('', `使用 #${charName}面板备份序号 查看对应备份的面板图`)
    e.reply(lines.join('\n'))
    return true
  }
}
