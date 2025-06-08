import React, { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import './Status.css';


function Status() {
    const [statusData, setStatusData] = useState([]);
    const socketRef = useRef(null);
    const heartbeatRef = useRef(null);
    const reconnectRef = useRef(null);

    // サーバから現在の入室状況を取得する関数
    const fetchStatus = useCallback(async () => {
    try {
      const response = await axios.get('http://10.1.132.10:3000/api/status');
      setStatusData(response.data);
      console.log(response.data);
    } catch (error) {
      console.error('Error fetching status data:', error);
    }
    }, []);

    useEffect(() => {
      // WebSocket接続を張り直す関数
      const connect = () => {
        const socket = new WebSocket('ws://10.1.132.10:3000');
        socketRef.current = socket;

        socket.onopen = () => {
          console.log("WS connected");
          fetchStatus(); //初回取得

          // 30秒ごとにpingを送信してアイドル切断を防止
          heartbeatRef.current = setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({type: 'ping'}));
            }
          }, 30000);
        };
        
        socket.onmessage = (event) => {
          const msg = JSON.parse(event.data);
          console.log('WS message:', msg);
          switch (msg.action){
            case 'refresh':
              fetchStatus();
              break;
            case 'update':
              fetchStatus();
              break;
            default:
              fetchStatus();
          }
        };

        socket.onclose = () => {
          console.warn('WS closed, retrying in 5s');
          clearInterval(heartbeatRef.current);
          reconnectRef.current = setTimeout(connect, 5000);
        };

        socket.onerror = (err) => {
          console.error('WS error', err);
          socket.close();
        };
      };

      connect();

      //定期ポーリング
      const pollId = setInterval(fetchStatus, 60 * 1000);
      
      // フォーカス復帰時にもフェッチ
    const onVisibility = () => {
      if (!document.hidden) fetchStatus();
    };
    window.addEventListener('visibilitychange', onVisibility);

    return () => {
      // クリーンアップ
      clearInterval(pollId);
      window.removeEventListener('visibilitychange', onVisibility);
      clearInterval(heartbeatRef.current);
      clearTimeout(reconnectRef.current);
      if (socketRef.current) socketRef.current.close();
    };
  }, [fetchStatus]);
      
    function getCurrentAcademicYear() {
      const today = new Date();
      const year = today.getFullYear();
      const month = today.getMonth(); // 0 = Jan, 3 = Apr,　・・・
      return month >= 3 ? year : year -1; 
    }
    const currentAcademicYear = getCurrentAcademicYear();

    const grouped = {
      k_and_master: [], //先生と修士 entry_year <= currentAcademicYear -2
      b4: [], //学部4年 entry_year === currentAcademicYear - 1
      b3: [] //学部3年 entry_year === currentAcademicYear
    }

    let K_num = 0;
    let D_num = 0;
    let A_num = 0;

    statusData.forEach((item) => {
      //場所毎に人数カウント
      if(item.room_name === "K棟"){
        K_num++;
      } else if(item.room_name === "D棟"){
        D_num++;
      } else if(item.room_name === "個研"){
        A_num++;
      }

      //学年毎に分ける
      const ey = item.entry_year;
      if(ey <= currentAcademicYear - 2){
        grouped.k_and_master.push(item);
      } else if (ey === currentAcademicYear -1) {
        grouped.b4.push(item);
      } else if (ey === currentAcademicYear) {
        grouped.b3.push(item);
      }
    })

    const maxRows = Math.max(grouped.k_and_master.length, grouped.b4.length, grouped.b3.length);

    const roomColorMap = {
      '個研': 'magenta',
      'K棟': 'blue',
      'D棟': 'green',
      '不在': 'silver',
      // その他必要な部屋を追加
    };
    

    return (
      <div style={{ width: '100vw', height: '100vh', margin: 0, padding: 0 }}>
            {/* <h2>現在の入室状況</h2> */}
            {/* <ul>
                {statusData.map((item, index) => (
                    <li key={index}>
                        {item.username} - {item.room_name} - {item.total_stay_duration}分
                    </li>
                ))}
            </ul> */}
            <h3>
              <span style={{ color: roomColorMap["K棟"] || 'black' }}>K棟：{K_num}名</span>
              {'　'}
              <span style={{ color: roomColorMap["D棟"] || 'black' }}>D棟：{D_num}名</span>
              {'　'}
              <span style={{ color: roomColorMap["個研"] || 'black' }}>個研：{A_num}名</span>
            </h3>
            <table className="table-fullscreen" border="1">
              <thead>
                <tr>
                  <th>先生 & 修士</th>
                  <th>学部4年</th>
                  <th>学部3年</th>
                </tr>
              </thead>
              <tbody>
                {[...Array(maxRows)].map((_, i) => {
                const km = grouped.k_and_master[i];
                const b4 = grouped.b4[i];
                const b3 = grouped.b3[i];
                return (
                  <tr key={i}>
                    {/* 先生・修士 列 */}
                    <td>
                      {km ? (
                        <>
                          {km.username} ／{' '}
                          <span style={{ color: roomColorMap[km.room_name] || 'black' }}>
                            {km.room_name}
                          </span>{' '}
                          ／ {Math.floor(km.total_stay_duration / 60)}時間
                          {km.total_stay_duration % 60}分
                        </>
                      ) : (
                        ''
                      )}
                    </td>
                    {/* 学部4年 列 */}
                    <td>
                      {b4 ? (
                        <>
                          {b4.username} ／{' '}
                          <span style={{ color: roomColorMap[b4.room_name] || 'black' }}>
                            {b4.room_name}
                          </span>{' '}
                          ／ {Math.floor(b4.total_stay_duration / 60)}時間
                          {b4.total_stay_duration % 60}分
                        </>
                      ) : (
                        ''
                      )}
                    </td>
                    {/* 学部3年 列 */}
                    <td>
                      {b3 ? (
                        <>
                          {b3.username} ／{' '}
                          <span style={{ color: roomColorMap[b3.room_name] || 'black' }}>
                            {b3.room_name}
                          </span>{' '}
                          ／ {Math.floor(b3.total_stay_duration / 60)}時間
                          {b3.total_stay_duration % 60}分
                        </>
                      ) : (
                        ''
                      )}
                    </td>
                  </tr>
                );
              })}
             </tbody>
            </table>
        </div>
    );
}

export default Status;
