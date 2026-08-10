/* ============================================================
   급식실 대기열 시뮬레이션
   전략: A 초기선착순 / B 반별순번제 / C 현재(U자선착순) /
        D 시차분산 제안 / E 순수 서펜타인(단일줄) / F 가상대기열(예약제)
   ============================================================ */

const STRATEGIES = {
  A: "A. 초기 선착순 (이동거리 불균등)",
  B: "B. 반별 순번제 (홀수반 왼쪽·짝수반 오른쪽)",
  C: "C. 현재 방식 (U자형 선착순, 두 줄)",
  D: "D. 제안: 시차 분산 배정",
  E: "E. 순수 서펜타인 (단일줄, 최적 이론형)",
  F: "F. 가상대기열 (예약제)"
};

const STATION_NAMES_BASE = ["밥", "반찬1", "반찬2", "반찬3", "국"];
const STATION_TIME = [2, 5]; // 스테이션당 소요 tick 범위
const HORIZON = 170;         // 도착 스케줄이 퍼지는 총 tick 범위
const RELEASE_INTERVAL_B = 22; // 반별 순번제: 반 쌍(pair) 간 간격 tick

// ---------- 유틸 ----------
const rnd = () => Math.random();
const randInt = (min, max) => Math.floor(min + rnd() * (max - min + 1));
const randRange = (min, max) => min + rnd() * (max - min);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function gaussian(mean, std) {
  let u = 1 - rnd(), v = rnd();
  return mean + std * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
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
        <span class="tick-badge" style="font-size:.7rem;color:#cfe6f5;">tick <span data-tick>0</span></span>
      </div>
      <div class="panel-body">
        <div class="controls">
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
            <div class="field">
              <label>학년 인원 <span data-out="pop"></span></label>
              <select data-ctl="population">
                <option value="345">2학년 · 345명(12반)</option>
                <option value="368">1학년 · 368명(12반)</option>
              </select>
            </div>
            <div class="field">
              <label>배식대 수 <span data-out="counters"></span></label>
              <input type="range" data-ctl="counters" min="1" max="4" step="1" value="2">
            </div>
            <div class="field check-row">
              <input type="checkbox" data-ctl="dessert" id="dessert-${this.label}">
              <label for="dessert-${this.label}" style="margin:0;">디저트 스테이션 있음</label>
            </div>
          </fieldset>

          <fieldset>
            <legend>친구 무리 도착 비율(%) — 자동 정규화</legend>
            <div class="field"><label>단독(1명) <span data-out="g1"></span></label>
              <input type="range" data-ctl="g1" min="0" max="100" value="35"></div>
            <div class="field"><label>2~3명 <span data-out="g2"></span></label>
              <input type="range" data-ctl="g2" min="0" max="100" value="35"></div>
            <div class="field"><label>4~5명 <span data-out="g3"></span></label>
              <input type="range" data-ctl="g3" min="0" max="100" value="20"></div>
            <div class="field"><label>6~8명 <span data-out="g4"></span></label>
              <input type="range" data-ctl="g4" min="0" max="100" value="10"></div>
          </fieldset>

          <fieldset>
            <legend>자율배식 (김치 등)</legend>
            <div class="field check-row">
              <input type="checkbox" data-ctl="autoEnabled" id="auto-${this.label}" checked>
              <label for="auto-${this.label}" style="margin:0;">자율배식 구간 사용</label>
            </div>
            <div class="field"><label>참여 학생 비율(%) <span data-out="autoRate"></span></label>
              <input type="range" data-ctl="autoRate" min="0" max="100" value="55"></div>
            <div class="field"><label>수용 인원(동시) <span data-out="autoCap"></span></label>
              <input type="range" data-ctl="autoCap" min="1" max="8" value="3"></div>
          </fieldset>

          <fieldset>
            <legend>감독 · 새치기</legend>
            <div class="field"><label>감독 교사 수 <span data-out="teachers"></span></label>
              <select data-ctl="teachers">
                <option value="2">2명 (문앞1 + 순찰1)</option>
                <option value="3">3명 (문앞1 + 순찰2)</option>
              </select>
            </div>
            <div class="field"><label>새치기 시도 확률 <span data-out="cheatProb"></span></label>
              <input type="range" data-ctl="cheatProb" min="0" max="100" value="30"></div>
            <div class="field"><label>적발 시 페널티(tick) <span data-out="penalty"></span></label>
              <input type="range" data-ctl="penalty" min="5" max="60" value="25"></div>
          </fieldset>

          <fieldset>
            <legend>실행</legend>
            <div class="field"><label>속도(tick/초) <span data-out="speed"></span></label>
              <input type="range" data-ctl="speed" min="1" max="20" value="8"></div>
            <div class="btn-row">
              <button class="btn" data-act="start">시작</button>
              <button class="btn secondary" data-act="pause">일시정지</button>
              <button class="btn danger" data-act="reset">초기화</button>
            </div>
          </fieldset>
        </div>

        <div class="stage">
          <canvas width="640" height="520"></canvas>
          <div class="stats">
            <div class="stat"><div class="k">현재 대기(L)</div><div class="v" data-stat="L">0</div></div>
            <div class="stat"><div class="k">평균 대기시간(W, tick)</div><div class="v" data-stat="W">0</div></div>
            <div class="stat"><div class="k">최대 대기시간</div><div class="v" data-stat="maxW">0</div></div>
            <div class="stat"><div class="k">처리 완료</div><div class="v" data-stat="served">0 / 0</div></div>
            <div class="stat"><div class="k">새치기 적발</div><div class="v" data-stat="caught">0</div></div>
            <div class="stat"><div class="k">새치기 성공</div><div class="v" data-stat="success">0</div></div>
            <div class="stat"><div class="k">새치기로 인한 지연(누적tick)</div><div class="v" data-stat="delay">0</div></div>
            <div class="stat"><div class="k">자율배식 정체(누적tick)</div><div class="v" data-stat="blocked">0</div></div>
          </div>
          <div class="legend">
            <span><i class="swatch" style="background:#3f8fc4"></i>대기중</span>
            <span><i class="swatch" style="background:#e0a72e"></i>배식중</span>
            <span><i class="swatch" style="background:#8a63d2"></i>자율배식</span>
            <span><i class="swatch" style="background:#2f9e6e"></i>완료·퇴장</span>
            <span><i class="swatch" style="background:#d64545"></i>새치기 적발/페널티</span>
          </div>
        </div>
      </div>
    `;
    this.canvas = this.root.querySelector("canvas");
    this.ctx = this.canvas.getContext("2d");
    this.ctlEls = {};
    this.root.querySelectorAll("[data-ctl]").forEach(el => {
      this.ctlEls[el.dataset.ctl] = el;
    });
    this.outEls = {};
    this.root.querySelectorAll("[data-out]").forEach(el => {
      this.outEls[el.dataset.out] = el;
    });
    this.statEls = {};
    this.root.querySelectorAll("[data-stat]").forEach(el => {
      this.statEls[el.dataset.stat] = el;
    });
    this.tickEl = this.root.querySelector("[data-tick]");
  }

  bindControls() {
    this.root.querySelectorAll("[data-ctl]").forEach(el => {
      el.addEventListener("input", () => this.syncOutputs());
    });
    this.root.querySelector('[data-act="start"]').addEventListener("click", () => this.start());
    this.root.querySelector('[data-act="pause"]').addEventListener("click", () => this.pause());
    this.root.querySelector('[data-act="reset"]').addEventListener("click", () => this.reset());
    this.syncOutputs();
  }

  syncOutputs() {
    const c = this.readConfig();
    if (this.outEls.pop) this.outEls.pop.textContent = `(${c.population}명)`;
    if (this.outEls.counters) this.outEls.counters.textContent = `${c.counters}개`;
    if (this.outEls.g1) this.outEls.g1.textContent = `${c.g1raw}`;
    if (this.outEls.g2) this.outEls.g2.textContent = `${c.g2raw}`;
    if (this.outEls.g3) this.outEls.g3.textContent = `${c.g3raw}`;
    if (this.outEls.g4) this.outEls.g4.textContent = `${c.g4raw}`;
    if (this.outEls.autoRate) this.outEls.autoRate.textContent = `${c.autoRate}%`;
    if (this.outEls.autoCap) this.outEls.autoCap.textContent = `${c.autoCap}명`;
    if (this.outEls.cheatProb) this.outEls.cheatProb.textContent = `${c.cheatProb}%`;
    if (this.outEls.penalty) this.outEls.penalty.textContent = `${c.penalty}`;
    if (this.outEls.speed) this.outEls.speed.textContent = `${c.speed}`;
  }

  readConfig() {
    const g = k => Number(this.ctlEls[k].value);
    return {
      strategy: this.ctlEls.strategy.value,
      population: g("population"),
      counters: g("counters"),
      dessert: this.ctlEls.dessert.checked,
      g1raw: g("g1"), g2raw: g("g2"), g3raw: g("g3"), g4raw: g("g4"),
      autoEnabled: this.ctlEls.autoEnabled.checked,
      autoRate: g("autoRate"),
      autoCap: g("autoCap"),
      teachers: g("teachers"),
      cheatProb: g("cheatProb"),
      penalty: g("penalty"),
      speed: g("speed")
    };
  }

  // ---------- 인구·그룹 생성 ----------
  buildPopulation(cfg) {
    const total = cfg.population;
    const weights = [cfg.g1raw, cfg.g2raw, cfg.g3raw, cfg.g4raw];
    const sum = weights.reduce((a, b) => a + b, 0) || 1;
    const norm = weights.map(w => w / sum);
    const sizeRanges = [[1, 1], [2, 3], [4, 5], [6, 8]];

    const groups = [];
    let remaining = total;
    let gid = 0;
    while (remaining > 0) {
      const r = rnd();
      let acc = 0, chosen = 0;
      for (let i = 0; i < 4; i++) { acc += norm[i]; if (r <= acc) { chosen = i; break; } }
      let size = randInt(sizeRanges[chosen][0], sizeRanges[chosen][1]);
      size = Math.min(size, remaining);
      groups.push({ id: gid++, size, classNum: (gid % 12) + 1 });
      remaining -= size;
    }
    return groups;
  }

  computeReleaseTick(strategy, group, groupIndex, totalGroups) {
    switch (strategy) {
      case "A": {
        const far = rnd() < 0.4;
        const base = clamp(gaussian(35, 20), 0, HORIZON);
        return Math.round(far ? clamp(base + randRange(30, 60), 0, HORIZON) : base);
      }
      case "B": {
        const pairIdx = Math.ceil(group.classNum / 2) - 1;
        return pairIdx * RELEASE_INTERVAL_B + randInt(0, 6);
      }
      case "C":
      case "E":
        return Math.round(clamp(gaussian(35, 18), 0, HORIZON));
      case "D":
        return Math.round(randRange(0, HORIZON));
      case "F":
        return Math.round((groupIndex / totalGroups) * HORIZON + randRange(-2, 2));
      default:
        return 0;
    }
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
      const releaseTick = this.computeReleaseTick(cfg.strategy, grp, gi, groups.length);
      for (let i = 0; i < grp.size; i++) {
        students.push({
          id: sid++,
          groupId: grp.id,
          classNum: grp.classNum,
          releaseTick: releaseTick + i, // 무리 내 입장 살짝 스태거
          released: false,
          line: null,
          state: "pending", // pending -> queueing -> serving -> autonomous -> done / penalty
          counter: null,
          stationIdx: -1,
          stationRemain: 0,
          queueEnterTick: null,
          exitTick: null,
          penaltyUntil: null,
          willUseAutonomous: rnd() * 100 < cfg.autoRate
        });
      }
    });
    this.students = students;
    this.totalPop = students.length;

    // 배식대 구성
    const leftCount = Math.ceil(cfg.counters / 2);
    const rightCount = cfg.counters - leftCount;
    const stationNames = cfg.dessert ? [...STATION_NAMES_BASE, "디저트"] : STATION_NAMES_BASE;
    this.stationNames = stationNames;
    this.counters = [];
    for (let i = 0; i < cfg.counters; i++) {
      this.counters.push({
        line: i < leftCount ? "L" : "R",
        stations: stationNames.map(() => ({ occupant: null, remain: 0, blocked: false }))
      });
    }

    this.lines = { L: [], R: [] };       // 대기줄 (queue) - 서로 다른 카운터 line 매칭용
    this.mainQueue = [];                  // 전략 E 전용 단일줄
    this.penaltyPool = [];                // 새치기 적발 후 대기
    this.autonomous = { occupants: [], cap: cfg.autoCap };

    this.stats = {
      served: 0, waitSum: 0, maxWait: 0,
      caught: 0, success: 0, delayTicks: 0, blockedTicks: 0
    };

    // 감독 교사 위치 (0=줄 시작 ~ 1=배식대 입구)
    this.teacherA = { pos: 0.96, radius: 0.10 };
    this.teacherB = { pos: 0, radius: 0.16, dir: 1, speed: 0.01 };
    this.teacherC = cfg.teachers === 3 ? { pos: 0.5, radius: 0.14, dir: -1, speed: 0.008 } : null;

    this.updateStatsUI();
    this.draw();
  }

  start() {
    if (this.running) return;
    this.running = true;
    const cfg = this.readConfig();
    const interval = Math.max(16, Math.round(1000 / cfg.speed));
    this.timer = setInterval(() => this.stepTick(), interval);
  }
  pause() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  coverageAt(pos) {
    const teachers = [this.teacherA, this.teacherB, this.teacherC].filter(Boolean);
    let best = 0.05; // 기본 미검출 확률(완전 무방비 구간은 없음)
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

  lineArrayIndexPos(lineArr, idx) {
    // idx=0(맨 앞, 배식대에 가까움) -> pos 근접 1 / idx=끝 -> pos 근접 0
    if (lineArr.length <= 1) return 0.9;
    return clamp(0.9 - (idx / lineArr.length) * 0.85, 0.02, 0.95);
  }

  stepTick() {
    this.tick++;
    const cfg = this.cfg;

    // 0) 교사 이동 (왕복)
    [this.teacherB, this.teacherC].forEach(t => {
      if (!t) return;
      t.pos += t.dir * t.speed;
      if (t.pos > 0.85 || t.pos < 0) { t.dir *= -1; t.pos = clamp(t.pos, 0, 0.85); }
    });

    // 1) 도착 처리
    this.students.forEach(s => {
      if (!s.released && s.releaseTick <= this.tick) {
        s.released = true;
        s.state = "queueing";
        s.queueEnterTick = this.tick;
        if (cfg.strategy === "E") {
          this.mainQueue.push(s);
        } else if (cfg.strategy === "B") {
          s.line = (s.classNum % 2 === 1) ? "L" : "R";
          this.lines[s.line].push(s);
        } else {
          const line = this.lines.L.length <= this.lines.R.length ? "L" : "R";
          s.line = line;
          this.lines[line].push(s);
        }
      }
    });

    // 2) 새치기 시도 (mainQueue 포함 두 종류 모두 처리)
    const attemptCheat = (arr) => {
      for (let i = 1; i < arr.length; i++) {
        const s = arr[i];
        if (rnd() < (cfg.cheatProb / 100) * 0.02) {
          const pos = this.lineArrayIndexPos(arr, i);
          const catchP = this.coverageAt(pos);
          if (rnd() < catchP) {
            // 적발: 대기열에서 제거 -> 페널티 풀
            arr.splice(i, 1);
            s.state = "penalty";
            s.penaltyUntil = this.tick + cfg.penalty;
            this.penaltyPool.push(s);
            this.stats.caught++;
          } else {
            // 성공: 앞으로 점프
            const jump = randInt(3, 10);
            const newIdx = Math.max(0, i - jump);
            arr.splice(i, 1);
            arr.splice(newIdx, 0, s);
            this.stats.success++;
            this.stats.delayTicks += (i - newIdx);
          }
          break; // 한 tick에 한 명만 처리(과도한 연쇄 방지)
        }
      }
    };
    if (cfg.strategy === "E") attemptCheat(this.mainQueue);
    else { attemptCheat(this.lines.L); attemptCheat(this.lines.R); }

    // 3) 페널티 종료 -> 맨 뒤 재진입
    this.penaltyPool = this.penaltyPool.filter(s => {
      if (s.penaltyUntil <= this.tick) {
        s.state = "queueing";
        if (cfg.strategy === "E") this.mainQueue.push(s);
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
      if (o.remain <= 0) {
        this.finalizeStudent(o.student);
        return false;
      }
      return true;
    });

    // 5) 배식대 파이프라인 처리 (뒤 스테이션부터)
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
            } else {
              st.blocked = true; // 자율배식 구간 정체 -> 역전파
              this.stats.blockedTicks++;
            }
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
          } else {
            st.blocked = true;
          }
        }
      }
      // 진입: 첫 스테이션이 비어 있으면 해당 라인 큐에서 다음 학생 진입
      const first = counter.stations[0];
      if (!first.occupant) {
        let nextStudent = null;
        if (cfg.strategy === "E") {
          nextStudent = this.mainQueue.shift();
        } else {
          const arr = this.lines[counter.line];
          nextStudent = arr.shift();
        }
        if (nextStudent) {
          nextStudent.state = "serving";
          nextStudent.counter = counter;
          first.occupant = nextStudent;
          first.remain = randInt(STATION_TIME[0], STATION_TIME[1]);
        }
      }
    });

    this.updateStatsUI();
    this.draw();

    // 종료 체크
    const allReleased = this.students.every(s => s.released || s.state === "done");
    const allDone = this.stats.served >= this.totalPop;
    if (allDone) this.pause();
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
    const L = this.lines.L.length + this.lines.R.length + this.mainQueue.length + this.penaltyPool.length;
    const W = this.stats.served ? (this.stats.waitSum / this.stats.served).toFixed(1) : "0";
    this.statEls.L.textContent = L;
    this.statEls.W.textContent = W;
    this.statEls.maxW.textContent = this.stats.maxWait;
    this.statEls.served.textContent = `${this.stats.served} / ${this.totalPop}`;
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

    const colors = { queueing: "#3f8fc4", serving: "#e0a72e", autonomous: "#8a63d2", done: "#2f9e6e", penalty: "#d64545" };

    // 두 줄(L/R) 렌더 (전략 E는 중앙 단일줄)
    const laneTop = 20, laneBottom = 300, dot = 8, gap = 3;
    const drawLane = (arr, x) => {
      const maxVisible = Math.floor((laneBottom - laneTop) / (dot + gap));
      const visible = arr.slice(0, maxVisible);
      visible.forEach((s, i) => {
        ctx.beginPath();
        ctx.fillStyle = colors[s.state] || "#999";
        ctx.arc(x, laneTop + i * (dot + gap), dot / 2, 0, Math.PI * 2);
        ctx.fill();
      });
      if (arr.length > maxVisible) {
        ctx.fillStyle = "#667085";
        ctx.font = "11px sans-serif";
        ctx.fillText(`+${arr.length - maxVisible}명 대기`, x - 24, laneBottom + 14);
      }
    };

    if (this.cfg.strategy === "E") {
      drawLane(this.mainQueue, W / 2);
      ctx.fillStyle = "#334"; ctx.font = "12px sans-serif";
      ctx.fillText("단일 서펜타인 줄", W / 2 - 40, 12);
    } else {
      drawLane(this.lines.L, W * 0.28);
      drawLane(this.lines.R, W * 0.72);
      ctx.fillStyle = "#334"; ctx.font = "12px sans-serif";
      ctx.fillText("왼쪽 줄", W * 0.28 - 18, 12);
      ctx.fillText("오른쪽 줄", W * 0.72 - 22, 12);
    }

    // 페널티 풀
    ctx.fillStyle = "#334"; ctx.font = "11px sans-serif";
    ctx.fillText(`새치기 격리 중: ${this.penaltyPool.length}명`, 10, laneBottom + 34);

    // 교사 시야
    const drawTeacher = (t, labelText) => {
      const y = laneTop + t.pos * (laneBottom - laneTop);
      ctx.beginPath();
      ctx.fillStyle = "rgba(214,69,69,0.10)";
      ctx.arc(W / 2, y, t.radius * (laneBottom - laneTop), 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.fillStyle = "#16243f";
      ctx.arc(W / 2, y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#16243f";
      ctx.font = "10px sans-serif";
      ctx.fillText(labelText, W / 2 + 8, y + 3);
    };
    drawTeacher(this.teacherA, "문앞");
    drawTeacher(this.teacherB, "순찰");
    if (this.teacherC) drawTeacher(this.teacherC, "순찰2");

    // 배식대 파이프라인
    const counterTop = 330, counterH = 46, stationW = 34;
    this.counters.forEach((c, ci) => {
      const totalW = c.stations.length * stationW;
      const startX = c.line === "L" ? W * 0.28 - totalW / 2 : W * 0.72 - totalW / 2;
      ctx.fillStyle = "#334"; ctx.font = "10px sans-serif";
      ctx.fillText(`배식대${ci + 1}(${c.line})`, startX, counterTop - 6);
      c.stations.forEach((st, si) => {
        const x = startX + si * stationW;
        ctx.strokeStyle = "#c3cad4";
        ctx.strokeRect(x, counterTop, stationW - 4, counterH);
        if (st.occupant) {
          ctx.fillStyle = st.blocked ? "#d64545" : colors[st.occupant.state] || "#e0a72e";
          ctx.fillRect(x + 3, counterTop + 3, stationW - 10, counterH - 6);
        }
        ctx.fillStyle = "#667085"; ctx.font = "8px sans-serif";
        ctx.fillText(this.stationNames[si], x + 2, counterTop + counterH + 10);
      });
    });

    // 자율배식 구간
    const autoY = 420;
    ctx.fillStyle = "#334"; ctx.font = "11px sans-serif";
    ctx.fillText(`자율배식 (김치 등) — ${this.autonomous.occupants.length}/${this.autonomous.cap}`, 10, autoY - 6);
    for (let i = 0; i < this.autonomous.cap; i++) {
      ctx.strokeStyle = "#c3cad4";
      ctx.strokeRect(10 + i * 30, autoY, 24, 24);
      if (this.autonomous.occupants[i]) {
        ctx.fillStyle = "#8a63d2";
        ctx.fillRect(13 + i * 30, autoY + 3, 18, 18);
      }
    }

    // 퇴장
    ctx.fillStyle = "#2f9e6e"; ctx.font = "13px sans-serif";
    ctx.fillText(`퇴장 완료: ${this.stats.served} / ${this.totalPop}`, 10, 480);
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
