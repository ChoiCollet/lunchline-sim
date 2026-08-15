/* ============================================================
   급식실 대기열 시뮬레이션 v2
   전략: A 초기선착순 / B 반별순번제 / C 현재(U자형 선착순) /
        D 시차분산 제안 / E 순수 서펜타인(단일줄, 이론최적) / F 가상대기열(예약제)

   공간 모델(2층 배치도 기준):
   계단실 쪽(대기열 시작) → 수석교사실 옆 공간(U자 곡선) → 방풍실 앞(분리 지점, 문앞교사)
   → (두 줄로 분리) → 식당 내부 배식대
   ============================================================ */

const STRATEGIES = {
  A: "A. 초기 선착순 (이동거리 불균등)",
  B: "B. 반별 순번제 (홀수반 왼쪽·짝수반 오른쪽)",
  C: "C. 현재 방식 (U자형 선착순 → 문앞에서 두 줄)",
  D: "D. 제안: 시차 분산 배정",
  E: "E. 순수 서펜타인 (단일줄, 이론 최적형)",
  F: "F. 가상대기열 (예약제)"
};
const CORRIDOR_STRATS = new Set(["A", "C", "D", "E", "F"]);

const STATION_NAMES_BASE = ["밥", "반찬1", "반찬2", "반찬3", "국"];
const STATION_TIME = [2, 5];
const HORIZON = 170;
const RELEASE_INTERVAL_B = 22;
const CLASS_PAIRS_B = 6; // 12개 반 -> 6쌍
const ALL_CLASS_DONE_TICK_B = CLASS_PAIRS_B * RELEASE_INTERVAL_B;

// ---------- 유틸 ----------
const rnd = () => Math.random();
const randInt = (min, max) => Math.floor(min + rnd() * (max - min + 1));
const randRange = (min, max) => min + rnd() * (max - min);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function gaussian(mean, std) {
  let u = 1 - rnd(), v = rnd();
  return mean + std * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function zoneLabel(t) {
  if (t < 0.15) return "계단실 쪽";
  if (t < 0.55) return "수석교사실 옆 공간";
  if (t < 0.85) return "방풍실 쪽 진행 구간";
  return "방풍실 앞(분리 지점)";
}

// ---------- U자형 경로 좌표 계산 ----------
// t=0(대기열 맨 뒤, 계단실 쪽) ~ t=1(대기열 맨 앞, 방풍실 앞 분리지점)
const CORR = { leftX: 90, rightX: 300, topY: 46, bottomY: 250 };
function corridorPoint(t) {
  const { leftX, rightX, topY, bottomY } = CORR;
  const leftLen = bottomY - topY;
  const r = (rightX - leftX) / 2;
  const curveLen = Math.PI * r;
  const rightLen = bottomY - topY;
  const total = leftLen + curveLen + rightLen;
  const d = clamp(t, 0, 1) * total;
  if (d <= leftLen) {
    return { x: leftX, y: topY + d };
  } else if (d <= leftLen + curveLen) {
    const a = (d - leftLen) / curveLen;
    const theta = Math.PI - a * Math.PI;
    const cx = (leftX + rightX) / 2, cy = bottomY;
    return { x: cx + r * Math.cos(theta), y: cy + r * Math.sin(theta) };
  } else {
    const d2 = d - leftLen - curveLen;
    return { x: rightX, y: bottomY - d2 };
  }
}

// ---------- 패널(=하나의 독립 시뮬레이션) ----------
class LunchLineSim {
  constructor(root, label) {
    this.root = root;
    this.label = label;
    this.running = false;
    this.tick = 0;
    this.timer = null;
    this.buildDOM();
    this.bindControls();
    this.reset();
  }

  buildDOM() {
    this.root.innerHTML = `
      <div class="panel-head">
        <h2>${this.label}</h2>
        <span style="font-size:.68rem;color:#cfe6f5;">tick <span data-tick>0</span></span>
      </div>

      <div class="controls-bar">
        <fieldset>
          <legend>대기열 전략</legend>
          <div class="field">
            <select data-ctl="strategy">
              ${Object.entries(STRATEGIES).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}
            </select>
          </div>
        </fieldset>

        <fieldset>
          <legend>규모 · 배식대</legend>
          <div class="field"><label>학년 인원 <span data-out="pop"></span></label>
            <select data-ctl="population">
              <option value="345">2학년 · 345명(12반)</option>
              <option value="368">1학년 · 368명(12반)</option>
            </select></div>
          <div class="field"><label>배식대 수 <span data-out="counters"></span></label>
            <input type="range" data-ctl="counters" min="1" max="4" step="1" value="2"></div>
          <div class="check-row">
            <input type="checkbox" data-ctl="dessert" id="dessert-${this.label}">
            <label for="dessert-${this.label}">디저트 스테이션</label>
          </div>
        </fieldset>

        <fieldset>
          <legend>친구 무리 비율(%)</legend>
          <div class="field"><label>단독 <span data-out="g1"></span></label>
            <input type="range" data-ctl="g1" min="0" max="100" value="35"></div>
          <div class="field"><label>2~3명 <span data-out="g2"></span></label>
            <input type="range" data-ctl="g2" min="0" max="100" value="35"></div>
          <div class="field"><label>4~5명 <span data-out="g3"></span></label>
            <input type="range" data-ctl="g3" min="0" max="100" value="20"></div>
          <div class="field"><label>6~8명 <span data-out="g4"></span></label>
            <input type="range" data-ctl="g4" min="0" max="100" value="10"></div>
        </fieldset>

        <fieldset>
          <legend>자율배식(김치 등)</legend>
          <div class="check-row">
            <input type="checkbox" data-ctl="autoEnabled" id="auto-${this.label}" checked>
            <label for="auto-${this.label}">사용</label>
          </div>
          <div class="field"><label>참여율(%) <span data-out="autoRate"></span></label>
            <input type="range" data-ctl="autoRate" min="0" max="100" value="55"></div>
          <div class="field"><label>수용 인원 <span data-out="autoCap"></span></label>
            <input type="range" data-ctl="autoCap" min="1" max="8" value="3"></div>
        </fieldset>

        <fieldset>
          <legend>감독 · 새치기</legend>
          <div class="field"><label>감독 교사 수 <span data-out="teachers"></span></label>
            <select data-ctl="teachers">
              <option value="2">2명(문앞1+순찰1)</option>
              <option value="3">3명(문앞1+순찰2)</option>
            </select></div>
          <div class="field"><label>새치기 시도확률 <span data-out="cheatProb"></span></label>
            <input type="range" data-ctl="cheatProb" min="0" max="100" value="30"></div>
          <div class="field"><label>페널티(tick) <span data-out="penalty"></span></label>
            <input type="range" data-ctl="penalty" min="5" max="60" value="25"></div>
        </fieldset>

        <fieldset>
          <legend>실행</legend>
          <div class="field"><label>속도(tick/초) <span data-out="speed"></span></label>
            <input type="range" data-ctl="speed" min="1" max="20" value="8"></div>
          <div class="btn-row">
            <button class="btn" data-act="start">시작</button>
            <button class="btn secondary" data-act="pause">정지</button>
            <button class="btn danger" data-act="reset">초기화</button>
          </div>
        </fieldset>
      </div>

      <div class="stage">
        <canvas width="780" height="460"></canvas>
        <div class="stats">
          <div class="stat"><div class="k">대기(L)</div><div class="v" data-stat="L">0</div></div>
          <div class="stat"><div class="k">평균대기(W,tick)</div><div class="v" data-stat="W">0</div></div>
          <div class="stat"><div class="k">최대대기</div><div class="v" data-stat="maxW">0</div></div>
          <div class="stat"><div class="k">처리완료</div><div class="v" data-stat="served">0/0</div></div>
          <div class="stat"><div class="k">새치기 적발</div><div class="v" data-stat="caught">0</div></div>
          <div class="stat"><div class="k">새치기 성공</div><div class="v" data-stat="success">0</div></div>
          <div class="stat"><div class="k">새치기 지연(tick)</div><div class="v" data-stat="delay">0</div></div>
          <div class="stat"><div class="k">자율배식 정체</div><div class="v" data-stat="blocked">0</div></div>
        </div>
        <div class="bottom-row">
          <div class="legend">
            <span><i class="swatch" style="background:#3f8fc4"></i>대기중</span>
            <span><i class="swatch" style="background:#e0a72e"></i>배식중</span>
            <span><i class="swatch" style="background:#8a63d2"></i>자율배식</span>
            <span><i class="swatch" style="background:#2f9e6e"></i>완료</span>
            <span><i class="swatch" style="background:#d64545"></i>적발</span>
            <span><i class="swatch" style="background:#f4b942;border:1px solid #b97e00"></i>친구대기(B)</span>
          </div>
          <div class="eventlog">
            <h3>새치기 이벤트 로그</h3>
            <ul data-eventlog></ul>
          </div>
        </div>
      </div>
    `;
    this.canvas = this.root.querySelector("canvas");
    this.ctx = this.canvas.getContext("2d");
    this.ctlEls = {};
    this.root.querySelectorAll("[data-ctl]").forEach(el => this.ctlEls[el.dataset.ctl] = el);
    this.outEls = {};
    this.root.querySelectorAll("[data-out]").forEach(el => this.outEls[el.dataset.out] = el);
    this.statEls = {};
    this.root.querySelectorAll("[data-stat]").forEach(el => this.statEls[el.dataset.stat] = el);
    this.tickEl = this.root.querySelector("[data-tick]");
    this.logEl = this.root.querySelector("[data-eventlog]");
  }

  bindControls() {
    this.root.querySelectorAll("[data-ctl]").forEach(el => el.addEventListener("input", () => this.syncOutputs()));
    this.root.querySelector('[data-act="start"]').addEventListener("click", () => this.start());
    this.root.querySelector('[data-act="pause"]').addEventListener("click", () => this.pause());
    this.root.querySelector('[data-act="reset"]').addEventListener("click", () => this.reset());
    this.syncOutputs();
  }

  syncOutputs() {
    const c = this.readConfig();
    const map = { pop: `(${c.population}명)`, counters: `${c.counters}개`, g1: c.g1raw, g2: c.g2raw, g3: c.g3raw, g4: c.g4raw,
      autoRate: `${c.autoRate}%`, autoCap: `${c.autoCap}명`, teachers: `${c.teachers}명`, cheatProb: `${c.cheatProb}%`,
      penalty: `${c.penalty}`, speed: `${c.speed}` };
    Object.entries(map).forEach(([k, v]) => { if (this.outEls[k]) this.outEls[k].textContent = v; });
  }

  readConfig() {
    const g = k => Number(this.ctlEls[k].value);
    return {
      strategy: this.ctlEls.strategy.value,
      population: g("population"), counters: g("counters"), dessert: this.ctlEls.dessert.checked,
      g1raw: g("g1"), g2raw: g("g2"), g3raw: g("g3"), g4raw: g("g4"),
      autoEnabled: this.ctlEls.autoEnabled.checked, autoRate: g("autoRate"), autoCap: g("autoCap"),
      teachers: g("teachers"), cheatProb: g("cheatProb"), penalty: g("penalty"), speed: g("speed")
    };
  }

  buildPopulation(cfg) {
    const total = cfg.population;
    const weights = [cfg.g1raw, cfg.g2raw, cfg.g3raw, cfg.g4raw];
    const sum = weights.reduce((a, b) => a + b, 0) || 1;
    const norm = weights.map(w => w / sum);
    const sizeRanges = [[1, 1], [2, 3], [4, 5], [6, 8]];
    const groups = [];
    let remaining = total, gid = 0;
    while (remaining > 0) {
      const r = rnd(); let acc = 0, chosen = 0;
      for (let i = 0; i < 4; i++) { acc += norm[i]; if (r <= acc) { chosen = i; break; } }
      let size = Math.min(randInt(sizeRanges[chosen][0], sizeRanges[chosen][1]), remaining);
      groups.push({ id: gid, size, classNum: (gid % 12) + 1 });
      gid++; remaining -= size;
    }
    return groups;
  }

  reset() {
    this.pause();
    const cfg = this.readConfig();
    this.cfg = cfg;
    this.tick = 0;

    const groups = this.buildPopulation(cfg);
    const students = [];
    let sid = 0;

    groups.forEach((grp, gi) => {
      let waitForFriends = false;
      if (cfg.strategy === "B" && grp.size >= 2) {
        const p = grp.size >= 4 ? 0.7 : 0.4;
        waitForFriends = rnd() < p;
      }
      let releaseTick;
      if (cfg.strategy === "B") {
        releaseTick = waitForFriends
          ? ALL_CLASS_DONE_TICK_B + randInt(0, 15)
          : (Math.ceil(grp.classNum / 2) - 1) * RELEASE_INTERVAL_B + randInt(0, 6);
      } else if (cfg.strategy === "A") {
        const far = rnd() < 0.4;
        const base = clamp(gaussian(35, 20), 0, HORIZON);
        releaseTick = Math.round(far ? clamp(base + randRange(30, 60), 0, HORIZON) : base);
        grp.isFar = far;
      } else if (cfg.strategy === "C" || cfg.strategy === "E") {
        releaseTick = Math.round(clamp(gaussian(35, 18), 0, HORIZON));
      } else if (cfg.strategy === "D") {
        releaseTick = Math.round(randRange(0, HORIZON));
      } else if (cfg.strategy === "F") {
        releaseTick = Math.round((gi / groups.length) * HORIZON + randRange(-2, 2));
      }

      for (let i = 0; i < grp.size; i++) {
        students.push({
          id: sid++, groupId: grp.id, groupSize: grp.size, classNum: grp.classNum,
          isFar: !!grp.isFar, waitForFriends,
          releaseTick: releaseTick + i, released: false,
          state: waitForFriends ? "friendwait" : "pending",
          counter: null, stationIdx: -1, stationRemain: 0,
          queueEnterTick: null, exitTick: null, penaltyUntil: null,
          willUseAutonomous: rnd() * 100 < cfg.autoRate
        });
      }
    });
    this.students = students;
    this.totalPop = students.length;

    const leftCount = Math.ceil(cfg.counters / 2);
    const stationNames = cfg.dessert ? [...STATION_NAMES_BASE, "디저트"] : STATION_NAMES_BASE;
    this.stationNames = stationNames;
    this.counters = [];
    for (let i = 0; i < cfg.counters; i++) {
      this.counters.push({
        line: i < leftCount ? "L" : "R",
        stations: stationNames.map(() => ({ occupant: null, remain: 0, blocked: false }))
      });
    }

    this.corridor = [];            // A/C/D/E/F: 단일 U자형 대기열
    this.lines = { L: [], R: [] }; // B: 반별 두 줄
    this.friendWaitPool = students.filter(s => s.waitForFriends); // B: 친구 기다림 구역(시각화용)
    this.penaltyPool = [];
    this.autonomous = { occupants: [], cap: cfg.autoCap };
    this.cheatFlashes = [];
    this.eventLog = [];

    this.stats = { served: 0, waitSum: 0, maxWait: 0, caught: 0, success: 0, delayTicks: 0, blockedTicks: 0 };

    // 감독 교사: t=0(계단실쪽) ~ t=1(방풍실 앞)
    this.teacherA = { pos: 0.97, radius: 0.09 };   // 문앞: 분리 지점 고정
    this.teacherB = { pos: 0.05, radius: 0.16, dir: 1, speed: 0.010, range: [0.0, cfg.teachers === 3 ? 0.55 : 0.9] };
    this.teacherC = cfg.teachers === 3 ? { pos: 0.55, radius: 0.15, dir: 1, speed: 0.009, range: [0.5, 0.95] } : null;
    this.reservationNext = 0; // F: 예약 다음 순번 표시용

    this.updateStatsUI();
    this.renderLog();
    this.draw();
  }

  start() {
    if (this.running) return;
    this.running = true;
    const cfg = this.readConfig();
    const interval = Math.max(16, Math.round(1000 / cfg.speed));
    this.timer = setInterval(() => this.stepTick(), interval);
  }
  pause() { this.running = false; if (this.timer) clearInterval(this.timer); this.timer = null; }

  coverageAt(pos) {
    const teachers = [this.teacherA, this.teacherB, this.teacherC].filter(Boolean);
    let best = 0.05;
    teachers.forEach(t => {
      const d = Math.abs(pos - t.pos);
      let p;
      if (d < t.radius) p = 0.92;
      else if (d < t.radius * 2) p = 0.92 * (1 - (d - t.radius) / t.radius);
      else p = 0.05;
      best = Math.max(best, p);
    });
    return clamp(best, 0.03, 0.95);
  }

  posOfIndex(arr, idx) {
    // idx=0(맨 앞, 분리지점에 가까움) -> pos 1에 근접 / idx=끝 -> pos 0에 근접
    if (arr.length <= 1) return 0.9;
    return clamp(0.9 - (idx / arr.length) * 0.85, 0.02, 0.95);
  }

  addCheatFlash(pos, caught) {
    let x, y;
    if (CORRIDOR_STRATS.has(this.cfg.strategy)) {
      const p = corridorPoint(pos);
      x = p.x; y = p.y;
    } else {
      // B: 왼쪽/오른쪽 줄 중 하나(둘 다 표시하기보다 임의로 왼쪽에 표시)
      x = CORR.leftX + 40; y = CORR.topY + pos * (CORR.bottomY - CORR.topY);
    }
    this.cheatFlashes.push({ x, y, until: this.tick + 15, caught });
  }

  pushLog(text, cls) {
    this.eventLog.unshift({ tick: this.tick, text, cls });
    if (this.eventLog.length > 5) this.eventLog.pop();
    this.renderLog();
  }
  renderLog() {
    if (!this.logEl) return;
    this.logEl.innerHTML = this.eventLog.map(e => `<li class="${e.cls}">tick ${e.tick} · ${e.text}</li>`).join("")
      || `<li style="color:#98a2b3">아직 발생한 새치기 없음</li>`;
  }

  stepTick() {
    this.tick++;
    const cfg = this.cfg;
    const corridorMode = CORRIDOR_STRATS.has(cfg.strategy);

    // 0) 교사 이동
    [this.teacherB, this.teacherC].forEach(t => {
      if (!t) return;
      t.pos += t.dir * t.speed;
      if (t.pos > t.range[1] || t.pos < t.range[0]) { t.dir *= -1; t.pos = clamp(t.pos, t.range[0], t.range[1]); }
    });

    // 1) 도착 처리
    this.students.forEach(s => {
      if (!s.released && s.releaseTick <= this.tick) {
        s.released = true;
        s.queueEnterTick = this.tick;
        if (s.waitForFriends) {
          this.friendWaitPool = this.friendWaitPool.filter(x => x.id !== s.id);
        }
        if (corridorMode) {
          s.state = "queueing";
          this.corridor.push(s);
        } else { // B
          s.state = "queueing";
          const line = s.waitForFriends
            ? (this.lines.L.length <= this.lines.R.length ? "L" : "R")
            : (s.classNum % 2 === 1 ? "L" : "R");
          s.line = line;
          this.lines[line].push(s);
        }
      }
    });

    // 2) 새치기 시도 (분리 지점 이전 구간에서만 발생)
    const attemptCheat = (arr) => {
      for (let i = 1; i < arr.length; i++) {
        const s = arr[i];
        if (rnd() < (cfg.cheatProb / 100) * 0.02) {
          const pos = this.posOfIndex(arr, i);
          const zone = corridorMode ? zoneLabel(pos) : (s.line === "L" ? "왼쪽 줄" : "오른쪽 줄");
          const catchP = this.coverageAt(pos);
          if (rnd() < catchP) {
            arr.splice(i, 1);
            s.state = "penalty";
            s.penaltyUntil = this.tick + cfg.penalty;
            this.penaltyPool.push(s);
            this.stats.caught++;
            this.addCheatFlash(pos, true);
            this.pushLog(`${zone}에서 새치기 시도 → 감독 교사에게 적발, ${cfg.penalty}tick 페널티`, "caught");
          } else {
            const jump = randInt(3, 10);
            const newIdx = Math.max(0, i - jump);
            arr.splice(i, 1);
            arr.splice(newIdx, 0, s);
            this.stats.success++;
            this.stats.delayTicks += (i - newIdx);
            this.addCheatFlash(pos, false);
            this.pushLog(`${zone}에서 새치기 시도 → 미적발, ${i - newIdx}명 추월`, "success");
          }
          break;
        }
      }
    };
    if (corridorMode) attemptCheat(this.corridor);
    else { attemptCheat(this.lines.L); attemptCheat(this.lines.R); }

    // 3) 페널티 종료 -> 맨 뒤 재진입
    this.penaltyPool = this.penaltyPool.filter(s => {
      if (s.penaltyUntil <= this.tick) {
        s.state = "queueing";
        if (corridorMode) this.corridor.push(s);
        else {
          const line = this.lines.L.length <= this.lines.R.length ? "L" : "R";
          s.line = line;
          this.lines[line].push(s);
        }
        return false;
      }
      return true;
    });

    // 4) 자율배식 처리
    this.autonomous.occupants = this.autonomous.occupants.filter(o => {
      o.remain--;
      if (o.remain <= 0) { this.finalizeStudent(o.student); return false; }
      return true;
    });

    // 5) 배식대 파이프라인
    this.counters.forEach(counter => {
      for (let idx = counter.stations.length - 1; idx >= 0; idx--) {
        const st = counter.stations[idx];
        if (!st.occupant) continue;
        if (st.remain > 0) { st.remain--; continue; }
        const isLast = idx === counter.stations.length - 1;
        if (isLast) {
          const s = st.occupant;
          if (s.willUseAutonomous && cfg.autoEnabled) {
            if (this.autonomous.occupants.length < this.autonomous.cap) {
              this.autonomous.occupants.push({ student: s, remain: randInt(4, 10) });
              s.state = "autonomous";
              st.occupant = null; st.blocked = false;
            } else { st.blocked = true; this.stats.blockedTicks++; }
          } else {
            this.finalizeStudent(s);
            st.occupant = null; st.blocked = false;
          }
        } else {
          const next = counter.stations[idx + 1];
          if (!next.occupant) {
            next.occupant = st.occupant;
            next.remain = randInt(STATION_TIME[0], STATION_TIME[1]);
            st.occupant = null; st.blocked = false;
          } else { st.blocked = true; }
        }
      }
    });

    // 6) 배식대 진입(첫 스테이션이 빈 곳에 다음 학생 배정)
    if (cfg.strategy === "E") {
      this.counters.forEach(counter => {
        const first = counter.stations[0];
        if (!first.occupant && this.corridor.length) {
          const s = this.corridor.shift();
          s.state = "serving"; s.counter = counter;
          first.occupant = s; first.remain = randInt(STATION_TIME[0], STATION_TIME[1]);
        }
      });
    } else if (cfg.strategy === "B") {
      this.counters.forEach(counter => {
        const first = counter.stations[0];
        if (!first.occupant) {
          const arr = this.lines[counter.line];
          const s = arr.shift();
          if (s) { s.state = "serving"; s.counter = counter; first.occupant = s; first.remain = randInt(STATION_TIME[0], STATION_TIME[1]); }
        }
      });
    } else {
      // A / C / D / F : 문 앞에서 "그때그때 더 짧은 쪽"으로 즉시 배정
      const freeCounters = this.counters.filter(c => !c.stations[0].occupant);
      while (this.corridor.length && freeCounters.length) {
        const occL = this.counters.filter(c => c.line === "L").reduce((a, c) => a + c.stations.filter(s => s.occupant).length, 0);
        const occR = this.counters.filter(c => c.line === "R").reduce((a, c) => a + c.stations.filter(s => s.occupant).length, 0);
        let preferSide = occL <= occR ? "L" : "R";
        let target = freeCounters.find(c => c.line === preferSide) || freeCounters[0];
        const s = this.corridor.shift();
        s.state = "serving"; s.counter = target;
        target.stations[0].occupant = s;
        target.stations[0].remain = randInt(STATION_TIME[0], STATION_TIME[1]);
        const fi = freeCounters.indexOf(target);
        freeCounters.splice(fi, 1);
      }
    }

    // 새치기 플래시 정리
    this.cheatFlashes = this.cheatFlashes.filter(f => f.until > this.tick);

    this.updateStatsUI();
    this.draw();

    if (this.stats.served >= this.totalPop) this.pause();
  }

  finalizeStudent(s) {
    s.state = "done";
    s.exitTick = this.tick;
    const wait = s.exitTick - s.queueEnterTick;
    this.stats.served++;
    this.stats.waitSum += wait;
    this.stats.maxWait = Math.max(this.stats.maxWait, wait);
  }

  updateStatsUI() {
    const L = (this.corridor ? this.corridor.length : 0) + this.lines.L.length + this.lines.R.length
      + this.penaltyPool.length + this.friendWaitPool.length;
    const W = this.stats.served ? (this.stats.waitSum / this.stats.served).toFixed(1) : "0";
    this.statEls.L.textContent = L;
    this.statEls.W.textContent = W;
    this.statEls.maxW.textContent = this.stats.maxWait;
    this.statEls.served.textContent = `${this.stats.served}/${this.totalPop}`;
    this.statEls.caught.textContent = this.stats.caught;
    this.statEls.success.textContent = this.stats.success;
    this.statEls.delay.textContent = this.stats.delayTicks;
    this.statEls.blocked.textContent = this.stats.blockedTicks;
    if (this.tickEl) this.tickEl.textContent = this.tick;
  }

  // ---------- 렌더링 ----------
  draw() {
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#eef2f6";
    ctx.fillRect(0, 0, W, H);

    const colors = { queueing: "#3f8fc4", serving: "#e0a72e", autonomous: "#8a63d2", done: "#2f9e6e", penalty: "#d64545", friendwait: "#f4b942" };
    const cfg = this.cfg;
    const corridorMode = CORRIDOR_STRATS.has(cfg.strategy);

    if (corridorMode) this.drawCorridorScene(ctx, colors);
    else this.drawClassLineScene(ctx, colors);

    this.drawCounters(ctx, colors, corridorMode);
    this.drawAutonomous(ctx);
    this.drawCheatFlashes(ctx);

    ctx.fillStyle = "#2f9e6e"; ctx.font = "12px sans-serif";
    ctx.fillText(`퇴장 완료: ${this.stats.served} / ${this.totalPop}`, 10, 448);
  }

  drawCorridorScene(ctx, colors) {
    const cfg = this.cfg;
    // 경로 자체를 옅게 표시
    ctx.strokeStyle = "#d7dde5"; ctx.lineWidth = 16; ctx.lineCap = "round";
    ctx.beginPath();
    for (let i = 0; i <= 40; i++) {
      const p = corridorPoint(i / 40);
      i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();

    // 구간 라벨
    ctx.fillStyle = "#8a94a6"; ctx.font = "10px sans-serif";
    ctx.fillText("계단실 쪽", CORR.leftX - 30, CORR.topY - 8);
    ctx.fillText("수석교사실 옆 공간", CORR.leftX - 10, CORR.bottomY + 26);
    ctx.fillText("방풍실 앞", CORR.rightX - 12, CORR.topY - 8);

    // 학생 점 (최대 60명 시각화, 초과분 텍스트)
    const arr = this.corridor;
    const maxVisible = 60;
    const visible = arr.slice(0, maxVisible);
    visible.forEach((s, i) => {
      const t = this.posOfIndex(arr, i);
      const p = corridorPoint(t);
      ctx.beginPath();
      ctx.fillStyle = colors[s.state] || "#999";
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fill();
      if (cfg.strategy === "A" && s.isFar) {
        ctx.strokeStyle = "#e0761a"; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2); ctx.stroke();
      }
    });
    if (arr.length > maxVisible) {
      ctx.fillStyle = "#667085"; ctx.font = "11px sans-serif";
      ctx.fillText(`+${arr.length - maxVisible}명 더 대기`, CORR.leftX - 10, CORR.topY - 22);
    }

    // 페널티 격리
    ctx.fillStyle = "#334"; ctx.font = "11px sans-serif";
    ctx.fillText(`새치기 격리 중: ${this.penaltyPool.length}명`, 10, 300);

    // 교사
    this.drawTeacherOnCorridor(ctx, this.teacherA, "문앞");
    this.drawTeacherOnCorridor(ctx, this.teacherB, "순찰");
    if (this.teacherC) this.drawTeacherOnCorridor(ctx, this.teacherC, "순찰2");

    // 전략별 배지
    if (cfg.strategy === "E") {
      ctx.fillStyle = "#334"; ctx.font = "11px sans-serif";
      ctx.fillText("※ 고정 두 줄 없음 — 비어있는 배식대로 즉시 배정(이론 최적형)", CORR.rightX + 20, 20);
    } else if (cfg.strategy === "D") {
      ctx.fillStyle = "#334"; ctx.font = "11px sans-serif";
      ctx.fillText("※ 시차 분산 공지 반영 — 도착이 시간대에 고르게 퍼짐", CORR.rightX + 20, 20);
    } else if (cfg.strategy === "F") {
      this.drawReservationBoard(ctx);
    }
  }

  drawTeacherOnCorridor(ctx, t, label) {
    const p = corridorPoint(t.pos);
    ctx.beginPath();
    ctx.fillStyle = "rgba(214,69,69,0.10)";
    ctx.arc(p.x, p.y, t.radius * 220, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.fillStyle = "#16243f";
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#16243f"; ctx.font = "10px sans-serif";
    ctx.fillText(label, p.x + 8, p.y + 3);
  }

  drawReservationBoard(ctx) {
    const done = this.stats.served + this.corridor.length + this.lines.L.length + this.lines.R.length;
    ctx.fillStyle = "#334"; ctx.font = "11px sans-serif";
    ctx.fillText(`예약 현황판 — 총 ${this.totalPop}석 중 ${this.stats.served}석 이용 완료`, CORR.rightX + 20, 36);
    ctx.fillText(`(예약 시간대에 맞춰 방풍실 앞으로만 잠깐 이동)`, CORR.rightX + 20, 50);
  }

  drawClassLineScene(ctx, colors) {
    const laneTop = 20, laneBottom = 260, dot = 8, gap = 3;
    const drawLane = (arr, x, label) => {
      const maxVisible = Math.floor((laneBottom - laneTop) / (dot + gap));
      const visible = arr.slice(0, maxVisible);
      visible.forEach((s, i) => {
        ctx.beginPath();
        ctx.fillStyle = colors[s.state] || "#999";
        ctx.arc(x, laneTop + i * (dot + gap), dot / 2, 0, Math.PI * 2);
        ctx.fill();
      });
      if (arr.length > maxVisible) {
        ctx.fillStyle = "#667085"; ctx.font = "11px sans-serif";
        ctx.fillText(`+${arr.length - maxVisible}명`, x - 20, laneBottom + 14);
      }
      ctx.fillStyle = "#334"; ctx.font = "12px sans-serif";
      ctx.fillText(label, x - 26, 12);
    };
    drawLane(this.lines.L, 130, "왼쪽 줄(홀수반)");
    drawLane(this.lines.R, 300, "오른쪽 줄(짝수반)");

    ctx.fillStyle = "#334"; ctx.font = "11px sans-serif";
    ctx.fillText(`새치기 격리 중: ${this.penaltyPool.length}명`, 10, 300);

    // 친구 기다림 구역
    const fx = 450, fy = 30, boxW = 300, boxH = 140;
    ctx.strokeStyle = "#e0a72e"; ctx.setLineDash([4, 3]);
    ctx.strokeRect(fx, fy, boxW, boxH);
    ctx.setLineDash([]);
    ctx.fillStyle = "#b97e00"; ctx.font = "11px sans-serif";
    ctx.fillText(`친구 기다림 구역 — 반이 다 지나갈 때까지 대기`, fx + 6, fy - 6);
    const groupsMap = {};
    this.friendWaitPool.forEach(s => { (groupsMap[s.groupId] ||= []).push(s); });
    let gi = 0;
    Object.values(groupsMap).forEach(members => {
      const col = gi % 6, row = Math.floor(gi / 6);
      const cx = fx + 20 + col * 46, cy = fy + 24 + row * 34;
      members.slice(0, 8).forEach((m, mi) => {
        ctx.beginPath();
        ctx.fillStyle = colors.friendwait;
        ctx.arc(cx + (mi % 4) * 8, cy + Math.floor(mi / 4) * 8, 3.4, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.fillStyle = "#7a5300"; ctx.font = "9px sans-serif";
      ctx.fillText(`${members.length}명`, cx - 2, cy + 26);
      gi++;
    });
    if (!Object.keys(groupsMap).length) {
      ctx.fillStyle = "#c9b083"; ctx.font = "10px sans-serif";
      ctx.fillText("(현재 대기 중인 무리 없음)", fx + 10, fy + 30);
    }

    // 교사(두 줄 위를 함께 순찰한다고 가정, 같은 높이에 표시)
    const drawTeacherLane = (t, label) => {
      const y = laneTop + t.pos * (laneBottom - laneTop);
      [130, 300].forEach(x => {
        ctx.beginPath(); ctx.fillStyle = "rgba(214,69,69,0.10)";
        ctx.arc(x, y, t.radius * (laneBottom - laneTop), 0, Math.PI * 2); ctx.fill();
      });
      ctx.beginPath(); ctx.fillStyle = "#16243f"; ctx.arc(215, y, 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#16243f"; ctx.font = "10px sans-serif"; ctx.fillText(label, 222, y + 3);
    };
    drawTeacherLane(this.teacherA, "문앞");
    drawTeacherLane(this.teacherB, "순찰");
    if (this.teacherC) drawTeacherLane(this.teacherC, "순찰2");
  }

  drawCounters(ctx, colors, corridorMode) {
    const counterTop = 300, counterH = 40, stationW = 32;
    const baseX = corridorMode ? CORR.rightX + 20 : 400;
    let li = 0, ri = 0;
    this.counters.forEach((c) => {
      const totalW = c.stations.length * stationW;
      const row = c.line === "L" ? li++ : ri++;
      const startX = baseX + row * (totalW + 14);
      const y = counterTop + (c.line === "L" ? 0 : 90);
      const labelSuffix = this.cfg.strategy === "E" ? "" : `(${c.line})`;
      ctx.fillStyle = "#334"; ctx.font = "10px sans-serif";
      ctx.fillText(`배식대${this.counters.indexOf(c) + 1}${labelSuffix}`, startX, y - 6);
      c.stations.forEach((st, si) => {
        const x = startX + si * stationW;
        ctx.strokeStyle = "#c3cad4";
        ctx.strokeRect(x, y, stationW - 4, counterH);
        if (st.occupant) {
          ctx.fillStyle = st.blocked ? "#d64545" : (colors[st.occupant.state] || "#e0a72e");
          ctx.fillRect(x + 3, y + 3, stationW - 10, counterH - 6);
        }
        ctx.fillStyle = "#667085"; ctx.font = "8px sans-serif";
        ctx.fillText(this.stationNames[si], x + 1, y + counterH + 9);
      });
    });
  }

  drawAutonomous(ctx) {
    const autoY = 400;
    ctx.fillStyle = "#334"; ctx.font = "11px sans-serif";
    ctx.fillText(`자율배식(김치 등) — ${this.autonomous.occupants.length}/${this.autonomous.cap}`, 340, autoY - 6);
    for (let i = 0; i < this.autonomous.cap; i++) {
      ctx.strokeStyle = "#c3cad4";
      ctx.strokeRect(340 + i * 28, autoY, 22, 22);
      if (this.autonomous.occupants[i]) {
        ctx.fillStyle = "#8a63d2";
        ctx.fillRect(343 + i * 28, autoY + 3, 16, 16);
      }
    }
  }

  drawCheatFlashes(ctx) {
    this.cheatFlashes.forEach(f => {
      const life = f.until - this.tick;
      const alpha = clamp(life / 15, 0, 1);
      ctx.beginPath();
      ctx.strokeStyle = f.caught ? `rgba(214,69,69,${alpha})` : `rgba(224,167,46,${alpha})`;
      ctx.lineWidth = 2.5;
      ctx.arc(f.x, f.y, 10 + (15 - life), 0, Math.PI * 2);
      ctx.stroke();
    });
  }
}

// ---------- 패널 매니저 ----------
const panelsEl = document.getElementById("panels");
const dualToggle = document.getElementById("dualModeToggle");
var sims = [];

function mountPanels(dual) {
  sims.forEach(s => s.pause());
  panelsEl.classList.toggle("dual", dual);
  panelsEl.innerHTML = "";
  sims = [];

  const a = document.createElement("div");
  a.className = "panel";
  panelsEl.appendChild(a);
  sims.push(new LunchLineSim(a, "패널 A"));

  if (dual) {
    const b = document.createElement("div");
    b.className = "panel";
    panelsEl.appendChild(b);
    sims.push(new LunchLineSim(b, "패널 B"));
  }
}

dualToggle.addEventListener("change", () => mountPanels(dualToggle.checked));
mountPanels(false);
