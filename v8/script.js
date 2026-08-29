/* ============================================================
   급식실 대기열 시뮬레이션 v4
   전략: A 초기선착순 / B 반별순번제 / C 현재(선착순 → 문앞에서 두 줄) /
        D 시차분산 제안 / E 순수 서펜타인(단일줄, 이론최적) / F 가상대기열(예약제)

   공간 모델(사용자 직접 제작 Archisketch 실측 평면도, 2026-08-29 + 현장 촬영 사진 9장):
   계단실(2층) → 1-8복도(수직, 실측 8.5m) → 급식실 입출구(문) 앞을 그대로 지나침
   → 급식실 오른복도·왼복도(실측 약 14.5m) → 학생 유도 라인(92㎡, 실측 11.8m —
     평면도에 벽으로 표시된 초록색 유도선 구간, 사진 속 바닥 초록선과 대응)
   → (줄이 줄어들며) 같은 복도를 되돌아 나와 → 급식실 입출구 왼쪽 벽의
     빨간색 "입장 대기선"에서 정지 → 입구(짝수반 左·홀수반 右, 바닥 노란 중앙선+
     빨강/파랑 표시) 통과 → 방풍실 진입 → 세면대 통로를 지나 두 줄로 갈라져 각 배식대로
     (퇴장은 별도 문·음수대(GOOTZ) 통로 이용 — drawExitZone 참고)
   ============================================================ */

const STRATEGIES = {
  A: "A. 초기 선착순 (이동거리 불균등)",
  B: "B. 반별 순번제 (짝수반 왼쪽·홀수반 오른쪽)",
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
const QUEUE_SPACING = 0.012; // 대기열에서 한 명이 차지하는 고정 간격(전체 대비 비율)
const CLASS_PAIRS_B = 6; // 12개 반 -> 6쌍
const ALL_CLASS_DONE_TICK_B = CLASS_PAIRS_B * RELEASE_INTERVAL_B;

// B 전략(반별 두 줄) 시각화에 쓰는 레인 좌표 — drawClassLineScene / addCheatFlash가 공유
const LANE_TOP = 20, LANE_BOTTOM = 260, LANE_X_L = 130, LANE_X_R = 300;

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
  if (t < GREEN_START_T) return "계단실~복도 (급식실 입출구 앞을 지나는 구간)";
  if (t < GREEN_END_T) return "학생 유도 라인(초록선) 대기 구간";
  if (t < RED_T) return "복도 되돌아가기(입장 순서를 기다리며 전진)";
  if (t < FORK_T) return "급식실 입출구 앞 빨간 입장 대기선";
  return "입구 통과, 세면대 지나 배식대로";
}

// ---------- 실측 기반 경로 좌표(사용자 Archisketch 평면도 + 현장 사진 대조) ----------
// 평면도 실측(mm): 1-8복도 높이 8529 / 급식실 오른복도 6555·왼복도 7978(가로) /
//   학생 유도 라인 바닥변 11785(≈11.8m, "EMPTY" 안쪽 라인은 대기열이 유도라인 방 안에서
//   한 번 꺾여 두 줄로 서는 형태로 반영) / 급식실 입출구 13㎡(빨간 대기선이 그려진 왼쪽 벽)
// 사진 대조: 짝수반 左·홀수반 右 안내판 + 바닥 노란 중앙선(빨강/파랑 표식) = 입구 문 앞,
//   세면대(수전 2개) = 입장 직후, GOOTZ 음수대 2대 = 퇴장 전용(별도 출구 문)
// 각 점은 "실제 이동 순서(대기열 맨 뒤 → 맨 앞)"를 따라 캔버스 좌표로 배치함
const PATH_POINTS = [
  { x: 345, y: 16,  m: "계단실(대기열 시작)" },
  { x: 345, y: 68,  m: "1-8복도 하단 — 계단 하강 실측 약 8.5m" },
  { x: 330, y: 68,  m: "급식실 입출구(문) 앞 — 지금은 그대로 지나침" },
  { x: 82,  y: 74,  m: "복도 서쪽 끝 — 급식실 오른·왼복도 실측 약 14.5m" },
  { x: 82,  y: 102, m: "학생 유도 라인 진입(노치 약 3m) — 초록선 시작" },
  { x: 18,  y: 102, m: "초록 유도선 1구간" },
  { x: 18,  y: 142, m: "유도선 꺾임(방 안쪽에서 두 번째 줄로)" },
  { x: 82,  y: 142, m: "초록 유도선 2구간 — 평면도 실측 총 약 11.8m" },
  { x: 300, y: 142, m: "복도 되돌아가기 — 약 14.5m 동쪽으로 전진" },
  { x: 326, y: 90,  m: "복도 재상승 — 급식실 입출구 쪽으로 복귀" },
  { x: 330, y: 72,  m: "급식실 입출구 왼쪽 벽 — 빨간 입장 대기선" },
  { x: 340, y: 66,  m: "입구 문 통과(짝수반 左 · 홀수반 右)" },
  { x: 362, y: 62,  m: "방풍실(전실) 진입 — 여기서부터 두 줄로 분기" }
];
const GREEN_START_IDX = 4, GREEN_END_IDX = 7, RED_IDX = 10, FORK_IDX = 11;

function buildPath(points) {
  const segLens = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    segLens.push(d);
    total += d;
  }
  return { points, segLens, total };
}
function pointAtT(path, t) {
  const target = clamp(t, 0, 1) * path.total;
  let acc = 0;
  for (let i = 0; i < path.segLens.length; i++) {
    const segLen = path.segLens[i];
    if (acc + segLen >= target || i === path.segLens.length - 1) {
      const localT = segLen > 0 ? clamp((target - acc) / segLen, 0, 1) : 0;
      const a = path.points[i], b = path.points[i + 1];
      return { x: a.x + (b.x - a.x) * localT, y: a.y + (b.y - a.y) * localT };
    }
    acc += segLen;
  }
  return path.points[path.points.length - 1];
}
function tAtIndex(path, idx) {
  let acc = 0;
  for (let i = 0; i < idx; i++) acc += path.segLens[i];
  return acc / path.total;
}

const MAIN_PATH = buildPath(PATH_POINTS);
function corridorPoint(t) { return pointAtT(MAIN_PATH, t); }

const GREEN_START_T = tAtIndex(MAIN_PATH, GREEN_START_IDX); // 학생 유도 라인(초록선) 시작
const GREEN_END_T = tAtIndex(MAIN_PATH, GREEN_END_IDX);     // 초록선 구간 끝, 복도로 되돌아감
const RED_T = tAtIndex(MAIN_PATH, RED_IDX);                 // 급식실 입출구 빨간 입장 대기선
const FORK_T = tAtIndex(MAIN_PATH, FORK_IDX);                // 입구 문 통과 지점(여기부터 두 줄로 포크)
const RED_MARK = corridorPoint(RED_T);
const DOOR_POINT = corridorPoint(FORK_T);

// 포크 갈림점(FORK_T, 입구 문 위치) 기준으로, 그 이후는 왼쪽줄(->세면대->배식대1)/오른쪽줄(->세면대->배식대2)로 갈라짐
const FORK_BASE = DOOR_POINT;
const FORK_TARGET_L = { x: 398, y: 58 };   // 왼쪽 줄이 향하는 배식대 방향
const FORK_TARGET_R = { x: 398, y: 150 };  // 오른쪽 줄이 향하는 배식대 방향
// 문 들어가서 세면대(손씻는 곳)를 지나 배식대까지 가는 구간의 중간 지점(세면대 위치)
const SINK_L = { x: FORK_BASE.x + (FORK_TARGET_L.x - FORK_BASE.x) * 0.45, y: FORK_BASE.y + (FORK_TARGET_L.y - FORK_BASE.y) * 0.45 };
const SINK_R = { x: FORK_BASE.x + (FORK_TARGET_R.x - FORK_BASE.x) * 0.45, y: FORK_BASE.y + (FORK_TARGET_R.y - FORK_BASE.y) * 0.45 };
function forkPoint(t, side) {
  const u = clamp((t - FORK_T) / (1 - FORK_T), 0, 1);
  const target = side === "L" ? FORK_TARGET_L : FORK_TARGET_R;
  return { x: FORK_BASE.x + (target.x - FORK_BASE.x) * u, y: FORK_BASE.y + (target.y - FORK_BASE.y) * u };
}
// 대기열에서 앞쪽 t가 FORK_T를 넘으면 포크 경로로, 그 전까지는 기존 경로로
function queuePoint(t, sideHint) {
  if (t < FORK_T) return corridorPoint(t);
  return forkPoint(t, sideHint);
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
            <input type="range" data-ctl="cheatProb" min="0" max="100" value="10"></div>
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
        <canvas width="760" height="360"></canvas>
        <div class="stats">
          <div class="stat" title="대기열+배식중+자율배식중 전체 (Little's Law의 L)"><div class="k">시스템 내 인원(L)</div><div class="v" data-stat="L">0</div></div>
          <div class="stat"><div class="k">최대대기열(peak L)</div><div class="v" data-stat="peakL">0</div></div>
          <div class="stat"><div class="k">평균대기(W,tick)</div><div class="v" data-stat="W">0</div></div>
          <div class="stat"><div class="k">최대대기시간</div><div class="v" data-stat="maxW">0</div></div>
          <div class="stat"><div class="k">처리완료</div><div class="v" data-stat="served">0/0</div></div>
          <div class="stat"><div class="k">새치기 적발</div><div class="v" data-stat="caught">0</div></div>
          <div class="stat"><div class="k">새치기 성공</div><div class="v" data-stat="success">0</div></div>
          <div class="stat"><div class="k">새치기 지연(tick)</div><div class="v" data-stat="delay">0</div></div>
          <div class="stat"><div class="k">자율배식 정체</div><div class="v" data-stat="blocked">0</div></div>
          <div class="stat" title="리틀의 법칙 검증용: 시간에 따른 L의 평균"><div class="k">시간평균 L</div><div class="v" data-stat="avgL">0</div></div>
          <div class="stat" title="처리율(도착률=서비스율, 정상상태 가정)"><div class="k">처리율 λ(명/tick)</div><div class="v" data-stat="lambda">0</div></div>
          <div class="stat" title="λ×W ≈ 시간평균 L 이면 리틀의 법칙 성립"><div class="k">λ×W(리틀법칙 검증)</div><div class="v" data-stat="verify">0</div></div>
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
          willUseAutonomous: rnd() * 100 < cfg.autoRate,
          // 새치기: 입장 시점에 "이 학생이 평생 한 번이라도 새치기를 시도할지"를 미리 정함
          // (매 tick 확률을 계속 굴리지 않음 -> 전체 시도 횟수가 슬라이더 %와 실제로 일치)
          willCheat: rnd() * 100 < cfg.cheatProb,
          cheatAttempted: false,
          cheatDelay: randInt(3, 45)
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

    this.stats = { served: 0, waitSum: 0, maxWait: 0, caught: 0, success: 0, delayTicks: 0, blockedTicks: 0, Lintegral: 0, peakL: 0 };

    // 감독 교사: t=0(계단실쪽) ~ t=1(방풍실 앞)
    this.teacherA = { pos: FORK_T, radius: 0.09 };   // 문앞: 입구 문(짝수반 左·홀수반 右) 위치에 고정
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

  posOfIndex(idx) {
    // 사람 한 명당 "고정 간격"만큼 뒤로 밀림 (대기열 전체 길이에 비례시키지 않음)
    // -> 줄이 짧을 때 억지로 넓게 퍼지거나, 길이 변화로 새치기 표시가 어긋나는 문제 방지
    return clamp(0.95 - idx * QUEUE_SPACING, 0, 0.95);
  }

  addCheatFlash(pos, caught) {
    let x, y;
    if (CORRIDOR_STRATS.has(this.cfg.strategy)) {
      const p = queuePoint(pos, "L");
      x = p.x; y = p.y;
    } else {
      // B: 왼쪽/오른쪽 줄 중 하나(둘 다 표시하기보다 임의로 왼쪽 레인에 표시)
      x = LANE_X_L; y = LANE_TOP + pos * (LANE_BOTTOM - LANE_TOP);
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
          // 실제 안내판 기준: 짝수반(2,4,6,8,10,12번)→왼쪽(左), 홀수반(1,3,5,7,9,11번)→오른쪽(右)
          const line = s.waitForFriends
            ? (this.lines.L.length <= this.lines.R.length ? "L" : "R")
            : (s.classNum % 2 === 0 ? "L" : "R");
          s.line = line;
          this.lines[line].push(s);
        }
      }
    });

    // 2) 새치기 시도 (입장 시 정해진 "새치기 성향" 학생이 자기 대기시간 중 1회만 시도)
    const attemptCheat = (arr) => {
      for (let i = 1; i < arr.length; i++) {
        const s = arr[i];
        if (!s.willCheat || s.cheatAttempted) continue;
        if (this.tick - s.queueEnterTick < s.cheatDelay) continue;
        s.cheatAttempted = true; // 결과(적발/성공)와 무관하게 평생 1회만 시도
        const pos = this.posOfIndex(i);
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
          const jump = randInt(1, 5);
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
    const inCounters = this.counters.reduce((a, c) => a + c.stations.filter(s => s.occupant).length, 0);
    const L = (this.corridor ? this.corridor.length : 0) + this.lines.L.length + this.lines.R.length
      + this.penaltyPool.length
      + inCounters + this.autonomous.occupants.length; // "시스템 내 전체 인원" = 대기 + 배식중 + 자율배식중
      // 친구 기다림 중인 학생(friendWaitPool)은 아직 실제로 줄에 서지 않은 상태라 L에서 제외
    this.stats.Lintegral += L;
    this.stats.peakL = Math.max(this.stats.peakL, L);
    const W = this.stats.served ? (this.stats.waitSum / this.stats.served).toFixed(1) : "0";
    const avgL = this.tick ? (this.stats.Lintegral / this.tick) : 0;
    const lambda = this.tick ? (this.stats.served / this.tick) : 0;
    const verify = lambda * parseFloat(W);
    this.statEls.L.textContent = L;
    this.statEls.W.textContent = W;
    this.statEls.maxW.textContent = this.stats.maxWait;
    this.statEls.peakL.textContent = this.stats.peakL;
    this.statEls.avgL.textContent = avgL.toFixed(2);
    this.statEls.lambda.textContent = lambda.toFixed(3);
    this.statEls.verify.textContent = verify.toFixed(2);
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
    this.drawAutonomous(ctx, corridorMode);
    this.drawCheatFlashes(ctx);

    this.drawExitZone(ctx);

    ctx.fillStyle = "#2f9e6e"; ctx.font = "12px sans-serif";
    ctx.fillText(`퇴장 완료: ${this.stats.served} / ${this.totalPop}`, 10, 348);
  }

  // 실측 사진 반영: 입구와 출구는 물리적으로 분리된 문이며, 출구 쪽 복도에
  // 음수대·손씻는 GOOTZ 유닛 2대가 나란히 놓여 있음(급식 후 퇴장 동선)
  drawExitZone(ctx) {
    const ex = 406, ey = 225, w = 170, h = 38;
    ctx.strokeStyle = "#b7c3da"; ctx.setLineDash([3, 2]);
    ctx.strokeRect(ex, ey, w, h);
    ctx.setLineDash([]);
    ctx.fillStyle = "#667085"; ctx.font = "9px sans-serif";
    ctx.fillText("출구 · GOOTZ 음수대/손씻는대(퇴장용)", ex, ey - 4);
    for (let i = 0; i < 4; i++) {
      ctx.strokeStyle = "#c3cad4";
      ctx.strokeRect(ex + 6 + i * 36, ey + 7, 26, 22);
    }
  }

  // 실측 사진 반영: 방풍실(전실) 안, 입구 문 지나자마자 손 씻는 세면대(별도 수전 2개)가 있음
  // (급식대로 가기 전 손씻기 — GOOTZ 음수대와는 다른, 퇴장용이 아닌 입장 직후 시설)
  drawSinkIcon(ctx, p) {
    ctx.strokeStyle = "#8fb4cf"; ctx.lineWidth = 1;
    ctx.strokeRect(p.x - 9, p.y - 6, 18, 12);
    ctx.beginPath(); ctx.fillStyle = "#cfe6f5";
    ctx.arc(p.x - 4, p.y, 2.2, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(p.x + 4, p.y, 2.2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#5c86a3"; ctx.font = "8px sans-serif";
    ctx.fillText("세면대", p.x - 12, p.y + 16);
  }

  // 현장 사진 반영: 입구 문 바로 앞 바닥에 노란 중앙선이 있고, 그 좌우로
  // 짝수반(左, 빨강 표식)·홀수반(右, 파랑 표식) 두 레인이 표시되어 있음(안내판과 함께 확인됨)
  drawEntranceDoor(ctx, p) {
    ctx.save();
    // 문짝 두 짝
    ctx.strokeStyle = "#9aa7bd"; ctx.lineWidth = 1.4;
    ctx.strokeRect(p.x - 13, p.y - 11, 11, 22);
    ctx.strokeRect(p.x + 2, p.y - 11, 11, 22);
    // 바닥 노란 중앙선(문틀 seam)
    ctx.strokeStyle = "#e8c332"; ctx.lineWidth = 3; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(p.x, p.y - 11); ctx.lineTo(p.x, p.y + 15); ctx.stroke();
    // 왼쪽(짝수반, 빨강 표식) / 오른쪽(홀수반, 파랑 표식) 바닥 표식
    ctx.beginPath(); ctx.fillStyle = "#d64545"; ctx.arc(p.x - 6, p.y + 15, 2.6, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.fillStyle = "#3f6fc4"; ctx.arc(p.x + 6, p.y + 15, 2.6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#8a94a6"; ctx.font = "8px sans-serif"; ctx.textAlign = "center";
    ctx.fillText("짝수반 左↑", p.x - 20, p.y + 26);
    ctx.fillText("홀수반 右↑", p.x + 20, p.y + 26);
    ctx.textAlign = "left";
    ctx.restore();
  }

  drawCorridorScene(ctx, colors) {
    const cfg = this.cfg;
    const strokeSeg = (t0, t1, style, width, steps = 20) => {
      ctx.strokeStyle = style; ctx.lineWidth = width; ctx.lineCap = "round";
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const t = t0 + (i / steps) * (t1 - t0);
        const p = corridorPoint(t);
        i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    };

    // 1) 계단실 → 급식실 입출구(문) 앞을 지나 복도 서쪽 끝까지(아직 페인트 없는 구간, 실측 약 8.5+14.5m)
    strokeSeg(0, GREEN_START_T, "#d7dde5", 15);
    // 2) 학생 유도 라인(초록선) — 평면도에 벽으로 표시된 실측 구간(약 11.8m), 여기서 실제로 줄을 섬
    strokeSeg(GREEN_START_T, GREEN_END_T, "#4caf7d", 15);
    // 3) 복도 되돌아가기 — 줄이 줄어들며 같은 복도를 다시 지나 입출구 쪽으로 전진
    strokeSeg(GREEN_END_T, RED_T, "#d7dde5", 13);
    // 4) 급식실 입출구 왼쪽 벽 ~ 입구 문 통과 직전(짧게 좁아짐)
    strokeSeg(RED_T, FORK_T, "#c9d2de", 11);

    // 빨간 입장 대기선(급식실 입출구 왼쪽 벽, 사진에서 확인된 위치) — 여기서 잠시 멈춤
    ctx.save();
    ctx.strokeStyle = "#d64545"; ctx.lineWidth = 4; ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(RED_MARK.x - 8, RED_MARK.y - 8);
    ctx.lineTo(RED_MARK.x + 8, RED_MARK.y + 8);
    ctx.stroke();
    ctx.restore();

    // FORK_T(입구 문) 지점부터 세면대를 지나 실제로 두 갈래(왼쪽줄/오른쪽줄)로 갈라지는 구간
    ctx.strokeStyle = "#c9d2de"; ctx.lineWidth = 11; ctx.lineCap = "round";
    ["L", "R"].forEach(side => {
      ctx.beginPath();
      for (let i = 0; i <= 12; i++) {
        const t = FORK_T + (i / 12) * (1 - FORK_T);
        const p = forkPoint(t, side);
        i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    });

    // 입구 문(짝수반 左·홀수반 右, 노란 중앙선) — 사진 기준 재현
    this.drawEntranceDoor(ctx, DOOR_POINT);

    // 급식실 입출구(문) — "지금은 그대로 지나침" 지점 표시(같은 문을 나중에 다시 들어옴)
    const passBy = PATH_POINTS[2];
    ctx.save();
    ctx.strokeStyle = "#b7c3da"; ctx.setLineDash([2, 2]); ctx.lineWidth = 1;
    ctx.strokeRect(passBy.x - 8, passBy.y - 20, 16, 10);
    ctx.setLineDash([]);
    ctx.fillStyle = "#8a94a6"; ctx.font = "8px sans-serif";
    ctx.fillText("급식실 입출구(지나침)", passBy.x - 34, passBy.y - 23);
    ctx.restore();

    // 구간 라벨 (Archisketch 실측 평면도 기준 구간명)
    ctx.fillStyle = "#8a94a6"; ctx.font = "9px sans-serif";
    ctx.fillText("계단실", PATH_POINTS[0].x - 24, PATH_POINTS[0].y + 8);
    ctx.fillText("1-8복도(약 8.5m)", PATH_POINTS[1].x - 46, PATH_POINTS[1].y + 12);
    ctx.fillText("급식실 오른·왼복도(약 14.5m)", PATH_POINTS[3].x - 4, PATH_POINTS[3].y - 8);
    ctx.fillStyle = "#2f8a5c";
    ctx.fillText("학생 유도 라인(초록선, 실측 약 11.8m)", PATH_POINTS[6].x - 60, PATH_POINTS[5].y - 8);
    ctx.fillStyle = "#8a94a6";
    ctx.fillText("복도 되돌아가기", PATH_POINTS[8].x - 40, PATH_POINTS[8].y + 14);
    ctx.fillStyle = "#c14a4a"; ctx.font = "8px sans-serif";
    ctx.fillText("빨간 입장 대기선", RED_MARK.x - 40, RED_MARK.y - 8);
    ctx.fillStyle = "#8a94a6"; ctx.font = "9px sans-serif";
    ctx.fillText("왼쪽줄→세면대→배식대1", FORK_TARGET_L.x - 66, FORK_TARGET_L.y - 6);
    ctx.fillText("오른쪽줄→세면대→배식대2", FORK_TARGET_R.x - 66, FORK_TARGET_R.y + 16);

    // 문 들어가서 세면대(손씻는 곳)를 지나 배식대까지: 실제 사진 확인된 손씻는 세면대 위치 표시
    this.drawSinkIcon(ctx, SINK_L);
    this.drawSinkIcon(ctx, SINK_R);

    // 학생 점: FORK_T 이전은 단일 줄, 이후는 좌/우 포크 경로로 갈라져서 표시
    // (배정된 배식대 쪽(L/R)이 있으면 그쪽 포크로, 아직 없으면 인덱스 홀짝으로 임시 표시)
    const arr = this.corridor;
    const maxVisible = Math.floor(0.93 / QUEUE_SPACING);
    const visible = arr.slice(0, maxVisible);
    visible.forEach((s, i) => {
      const t = this.posOfIndex(i);
      const sideHint = s.line || (i % 2 === 0 ? "L" : "R");
      const p = queuePoint(t, sideHint);
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
      ctx.fillText(`+${arr.length - maxVisible}명 더 대기`, 10, 12);
    }

    // 페널티 격리
    ctx.fillStyle = "#334"; ctx.font = "11px sans-serif";
    ctx.fillText(`새치기 격리 중: ${this.penaltyPool.length}명`, 10, 235);

    // 교사
    this.drawTeacherOnCorridor(ctx, this.teacherA, "문앞");
    this.drawTeacherOnCorridor(ctx, this.teacherB, "순찰");
    if (this.teacherC) this.drawTeacherOnCorridor(ctx, this.teacherC, "순찰2");

    // 전략별 배지
    if (cfg.strategy === "E") {
      ctx.fillStyle = "#334"; ctx.font = "11px sans-serif";
      ctx.fillText("※ 고정 두 줄 없음 — 비어있는 배식대로 즉시 배정(이론 최적형)", 10, 255);
    } else if (cfg.strategy === "D") {
      ctx.fillStyle = "#334"; ctx.font = "11px sans-serif";
      ctx.fillText("※ 시차 분산 공지 반영 — 도착이 시간대에 고르게 퍼짐", 10, 255);
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
    ctx.fillStyle = "#334"; ctx.font = "11px sans-serif";
    ctx.fillText(`예약 현황판 — 총 ${this.totalPop}석 중 ${this.stats.served}석 이용 완료`, 10, 255);
    ctx.fillText(`(예약 시간대에 맞춰 손씻는 곳 앞으로만 잠깐 이동)`, 10, 268);
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
    drawLane(this.lines.L, 130, "왼쪽 줄(짝수반)");
    drawLane(this.lines.R, 300, "오른쪽 줄(홀수반)");

    // 실제 안내판 문구 재현 (사진 확인: 짝수반 左 / 홀수반 右)
    ctx.fillStyle = "#8a94a6"; ctx.font = "9px sans-serif";
    ctx.fillText("짝수반 (2,4,6,8,10,12번) 左↑", 90, laneBottom + 30);
    ctx.fillText("홀수반 (1,3,5,7,9,11번) 右↑", 258, laneBottom + 30);

    ctx.fillStyle = "#334"; ctx.font = "11px sans-serif";
    ctx.fillText(`새치기 격리 중: ${this.penaltyPool.length}명`, 10, 300);

    // 친구 기다림 구역 (넘치면 "+N개 그룹 더"로 표시, 배식대 영역과 겹치지 않게 높이 제한)
    const fx = 430, fy = 12, boxW = 330, boxH = 118;
    ctx.strokeStyle = "#e0a72e"; ctx.setLineDash([4, 3]);
    ctx.strokeRect(fx, fy, boxW, boxH);
    ctx.setLineDash([]);
    ctx.fillStyle = "#b97e00"; ctx.font = "10px sans-serif";
    ctx.fillText(`친구 기다림 구역 — 반이 다 지나갈 때까지 대기`, fx + 4, fy - 4);
    const groupsMap = {};
    this.friendWaitPool.forEach(s => { (groupsMap[s.groupId] ||= []).push(s); });
    const allGroups = Object.values(groupsMap);
    const cols = 6, rowH = 34, maxRows = Math.floor((boxH - 14) / rowH);
    const maxGroups = cols * maxRows;
    const shownGroups = allGroups.slice(0, maxGroups);
    shownGroups.forEach((members, gi) => {
      const col = gi % cols, row = Math.floor(gi / cols);
      const cx = fx + 18 + col * 52, cy = fy + 20 + row * rowH;
      members.slice(0, 8).forEach((m, mi) => {
        ctx.beginPath();
        ctx.fillStyle = colors.friendwait;
        ctx.arc(cx + (mi % 4) * 7, cy + Math.floor(mi / 4) * 7, 3, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.fillStyle = "#7a5300"; ctx.font = "9px sans-serif";
      ctx.fillText(`${members.length}명`, cx - 2, cy + 20);
    });
    if (!allGroups.length) {
      ctx.fillStyle = "#c9b083"; ctx.font = "10px sans-serif";
      ctx.fillText("(현재 대기 중인 무리 없음)", fx + 10, fy + 24);
    } else if (allGroups.length > maxGroups) {
      ctx.fillStyle = "#b97e00"; ctx.font = "9px sans-serif";
      ctx.fillText(`+${allGroups.length - maxGroups}개 그룹 더 대기 중`, fx + 8, fy + boxH - 4);
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
    const counterTop = corridorMode ? 55 : 150;
    const counterH = 34, stationW = corridorMode ? 26 : 30;
    const baseX = corridorMode ? 406 : 430;
    const rowGap = corridorMode ? 90 : 84;
    let li = 0, ri = 0;
    this.counters.forEach((c) => {
      const totalW = c.stations.length * stationW;
      const row = c.line === "L" ? li++ : ri++;
      const startX = baseX + row * (totalW + 12);
      const y = counterTop + (c.line === "L" ? 0 : rowGap);
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

  drawAutonomous(ctx, corridorMode) {
    const autoX = corridorMode ? 406 : 430;
    const autoY = corridorMode ? 195 : 300;
    ctx.fillStyle = "#334"; ctx.font = "11px sans-serif";
    ctx.fillText(`자율배식(김치 등) — ${this.autonomous.occupants.length}/${this.autonomous.cap}`, autoX, autoY - 6);
    for (let i = 0; i < this.autonomous.cap; i++) {
      ctx.strokeStyle = "#c3cad4";
      ctx.strokeRect(autoX + i * 28, autoY, 22, 22);
      if (this.autonomous.occupants[i]) {
        ctx.fillStyle = "#8a63d2";
        ctx.fillRect(autoX + 3 + i * 28, autoY + 3, 16, 16);
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
