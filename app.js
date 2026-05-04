const { App } = require('@slack/bolt');
const { getOrgData } = require('./salesforce');
require('dotenv').config();

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN
});

// =========================================================
// 🚀 [핵심 기술] 데이터 캐싱 & 슬랙 프로필 사진 매칭
// =========================================================
let sfUsersCache = []; 
let cacheTimestamp = 0; 
const CACHE_TTL = 5 * 60 * 1000; 

// 1. 슬랙 워크스페이스의 모든 유저 사진을 가져오는 함수
async function getSlackAvatars(client) {
  try {
    const result = await client.users.list();
    const avatarMap = {};
    
    // 이메일을 열쇠(Key)로, 사진 URL을 값(Value)으로 하는 딕셔너리 생성
    result.members.forEach(member => {
      if (member.profile && member.profile.email) {
        // 해상도가 좋은 image_192 사이즈를 가져옵니다.
        avatarMap[member.profile.email] = member.profile.image_192; 
      }
    });
    return avatarMap;
  } catch (error) {
    console.error('슬랙 유저 목록 가져오기 에러:', error);
    return {};
  }
}

// 2. 세일즈포스 데이터와 슬랙 사진을 합치는 함수
async function getCachedOrgData(client) {
  const now = Date.now();
  
  if (sfUsersCache.length === 0 || (now - cacheTimestamp > CACHE_TTL)) {
    console.log('⏳ 세일즈포스 & 슬랙에서 최신 데이터를 가져와 조립합니다...');
    
    // 두 작업을 동시에 실행하여 속도 최적화 (Promise.all)
    const [sfData, slackAvatars] = await Promise.all([
      getOrgData(),
      getSlackAvatars(client)
    ]);

    // 세일즈포스 데이터에 슬랙 프로필 사진 URL 끼워넣기
    sfUsersCache = sfData.map(user => {
      return {
        ...user,
        // 이메일이 일치하면 슬랙 사진, 없으면 슬랙 기본 회색 사람 이미지
        SlackAvatar: slackAvatars[user.Email] || "https://a.slack-edge.com/80588/img/avatars-teams/ava_0000-192.png"
      };
    });
    
    cacheTimestamp = now;
  } else {
    console.log('⚡️ 저장된 캐시 데이터를 사용합니다.');
  }
  return sfUsersCache;
}

// ---------------------------------------------------------
// 🎨 [공통 함수] App Home 화면을 그려주는 함수
// ---------------------------------------------------------
async function updateHomeView(client, userId, selectedDepartment = 'all') {
  // 캐시 함수에 client(슬랙 봇 객체)를 전달해야 사진을 긁어올 수 있습니다!
  const sfUsers = await getCachedOrgData(client); 

  const departments = [...new Set(sfUsers.map(u => u.Department).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));

  const filterOptions = [
    { "text": { "type": "plain_text", "text": "전체 보기" }, "value": "all" }
  ];

  departments.forEach(dept => {
    filterOptions.push({ "text": { "type": "plain_text", "text": dept }, "value": dept });
  });

  let filteredUsers = sfUsers;
  if (selectedDepartment !== 'all') {
    filteredUsers = sfUsers.filter(u => u.Department === selectedDepartment);
  }

  // 4. 필터링된 유저 데이터를 슬랙 UI 블록으로 변환 (UI 구조 변경)
  const userBlocks = [];
  filteredUsers.forEach(user => {
    const title = user.Title || '직책 없음';
    const dept = user.Department || '소속 없음';
    const userDataStr = JSON.stringify(user);

    // 구역 1: 이름, 정보, 그리고 프로필 사진
    userBlocks.push({
      "type": "section",
      "text": { 
        "type": "mrkdwn", 
        "text": `*${user.Name}*\n${title} | ${dept}\n📧 ${user.Email}` 
      },
      "accessory": {
        "type": "image",
        "image_url": user.SlackAvatar,
        "alt_text": `${user.Name}의 프로필 사진`
      }
    });

    // 구역 2: 상세보기 버튼 (사진과 버튼을 같이 둘 수 없어서 아래로 뺐습니다)
    userBlocks.push({
      "type": "actions",
      "elements": [
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "🔍 프로필 상세보기" },
          "value": userDataStr,
          "action_id": "open_user_modal"
        }
      ]
    });

    // 구분선 추가
    userBlocks.push({ "type": "divider" });
  });

  if (userBlocks.length === 0) {
    userBlocks.push({
      "type": "section",
      "text": { "type": "mrkdwn", "text": "해당 부서에 등록된 직원이 없습니다." }
    });
  }

  await client.views.publish({
    user_id: userId,
    view: {
      type: 'home',
      blocks: [
        { "type": "header", "text": { "type": "plain_text", "text": "🏢 우리회사 조직도" } },
        {
          "type": "actions",
          "elements": [
            {
              "type": "static_select",
              "placeholder": { "type": "plain_text", "text": "부서 필터링..." },
              "options": filterOptions,
              "initial_option": filterOptions.find(opt => opt.value === selectedDepartment),
              "action_id": "filter_department"
            }
          ]
        },
        { "type": "divider" },
        ...userBlocks 
      ]
    }
  });
}

// ---------------------------------------------------------
// 🚀 [이벤트 및 액션 핸들러]
// ---------------------------------------------------------

app.event('app_home_opened', async ({ event, client, logger }) => {
  try {
    await client.views.publish({
      user_id: event.user,
      view: {
        type: 'home',
        blocks: [
          { "type": "header", "text": { "type": "plain_text", "text": "🏢 우리회사 조직도" } },
          { "type": "section", "text": { "type": "mrkdwn", "text": "\n\n⏳ *데이터를 동기화하는 중입니다...*\n\n" } }
        ]
      }
    });
    await updateHomeView(client, event.user, 'all');
  } catch (error) {
    logger.error('앱 홈 열기 에러:', error);
  }
});

app.action('filter_department', async ({ ack, body, client, logger }) => {
  await ack(); 
  try {
    const selectedDepartment = body.actions[0].selected_option.value;
    await updateHomeView(client, body.user.id, selectedDepartment);
  } catch (error) {
    logger.error('부서 필터링 에러:', error);
  }
});

app.action('open_user_modal', async ({ ack, body, client, logger }) => {
  await ack();
  try {
    const user = JSON.parse(body.actions[0].value);
    const address = [user.City, user.Street].filter(Boolean).join(' ') || '등록된 주소 없음';
    const managerName = user.Manager ? user.Manager.Name : '상급자 없음';
    const email = user.Email || '이메일 없음';
    const phone = user.Phone || '전화번호 없음';

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        title: { type: 'plain_text', text: `${user.Name} 프로필` },
        blocks: [
          // 팝업창 상단에도 프로필 사진을 큼직하게 띄워줍니다!
          {
            "type": "section",
            "text": { "type": "mrkdwn", "text": `*${user.Name}*\n${user.Title || '직책 없음'} | ${user.Department || '소속 없음'}` },
            "accessory": {
              "type": "image",
              "image_url": user.SlackAvatar,
              "alt_text": `${user.Name}의 프로필 사진`
            }
          },
          { "type": "divider" },
          { "type": "section", "text": { "type": "mrkdwn", "text": `*이메일:*\n📧 ${email}` } },
          { "type": "section", "text": { "type": "mrkdwn", "text": `*전화번호:*\n📞 ${phone}` } },
          { "type": "section", "text": { "type": "mrkdwn", "text": `*상급자:*\n👤 ${managerName}` } },
          { "type": "section", "text": { "type": "mrkdwn", "text": `*근무지 주소:*\n📍 ${address}` } }
        ]
      }
    });
  } catch (error) {
    logger.error('팝업 띄우기 에러:', error);
  }
});

// 봇 실행
(async () => {
  // 서버가 지정해 주는 포트가 있으면 그걸 쓰고, 없으면 3000번을 쓴다는 의미입니다.
  await app.start(process.env.PORT || 3000);
  console.log('⚡️ 성공! 클라우드 서버에서 봇이 돌아갑니다!');
})();