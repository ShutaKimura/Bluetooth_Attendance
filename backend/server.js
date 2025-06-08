import cors from 'cors';
import mysql from 'mysql2/promise';  // mysql2/promise モジュールのインポート
import express from 'express';       // expressフレームワークのインポート
import bodyParser from 'body-parser'; // リクエストボディを解析するためのモジュールのインポート
import http from 'http';             // HTTPサーバーを作成するためのモジュールのインポート
import { createServer } from 'http'; // HTTPサーバーを作成するための関数のインポート
import { WebSocketServer } from 'ws';// WebSocketサーバー用のモジュールのインポート
import dotenv from 'dotenv';         // 環境変数をロードするためのモジュールのインポート
import schedule from 'node-schedule';
import nodemailer from 'nodemailer';
dotenv.config();                     // .envファイル内の変数をprocess.envにロード

const app = express();               // Expressアプリケーションの作成

app.use(cors()); // CORSを有効にする

const server = createServer(app);    // HTTPサーバーの作成
const wss = new WebSocketServer({ server }); // WebSocketサーバーの作成

// === WebSocket heartbeat ===
// 接続時に isAlive フラグを立て、pong を返してもらう
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
});

// 30秒ごとに全クライアントに ping を送信し、応答がなければ切断
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// サーバ停止時はクリア
server.on('close', () => clearInterval(heartbeatInterval));

// MySQLデータベース接続プールの設定
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

app.use(bodyParser.json());          // リクエストボディをJSON形式として解析するミドルウェアを使用

// 新規ユーザ登録エンドポイント
app.post('/api/register', async (req, res) => {
    const { user_id, username, entry_year, mac_address } = req.body;

    try {
        const connection = await pool.getConnection(); // データベース接続を取得
        await connection.beginTransaction(); // トランザクションの開始

        try {
            // Usersテーブルに新規ユーザを登録
            const [userResult] = await connection.query('INSERT INTO Users (user_id, username, entry_year) VALUES (?, ?, ?)', [user_id, username, entry_year]);

            // MACaddressテーブルに情報を登録
            await connection.query('INSERT INTO MACaddress (mac_address, user_id) VALUES (?, ?)', [mac_address, user_id]);

            // CardStatusテーブルに初期ステータスを登録
            await connection.query('INSERT INTO CardStatus (mac_address, current_room_id) VALUES (?, ?)', [mac_address, 1]);

            // StayTimeテーブルに初期ステータスを登録
            await connection.query('INSERT INTO StayTime (mac_address, total_stay_duration, threshold_exceeded, forgetCount) VALUES (?, 0, 0, 0)',[mac_address]);

            await connection.commit(); // トランザクションをコミット
            res.status(201).json({ message: 'User registered successfully', user_id, mac_address });

            // WebSocketを通じてクライアントに通知
            wss.clients.forEach(client => {
                if (client.readyState === client.OPEN) {
                    const message = JSON.stringify({
                        action: 'refresh'
                    });
                    console.log(`Sending message: ${message}`);  // 送信メッセージの確認
                    client.send(message);
                }
            });

        } catch (err) {
            await connection.rollback(); // トランザクションをロールバック
            throw err;
        } finally {
            connection.release(); // データベース接続を解放
        }
    } catch (err) {
        console.error(err); // エラーログの出力
        res.status(500).json({ message: 'Internal Server Error', error: err.message }); // エラーレスポンスの送信
    }
});

app.post('/api/notify-detected-user', async (req, res) => {
    const { mac_address, room_id } = req.body;
    const currentTime = new Date();
    console.log(`Received POST request: mac_address=${mac_address}, room_id=${room_id}`);

    try {
        const connection = await pool.getConnection();
        await connection.beginTransaction();

        try {
            const [cardStatusRows] = await connection.query('SELECT current_room_id FROM CardStatus WHERE mac_address = ?', [mac_address]);

            if (cardStatusRows.length === 0) {
                res.status(404).json({ message: 'MACaddress not recognized' });

                wss.clients.forEach(client => {
                    if (client.readyState === client.OPEN) {
                        const message = JSON.stringify({
                            action: 'register',
                            room_id
                        });
                        console.log(`Sending registration request: ${message}`);
                        client.send(message);
                    }
                });

                await connection.rollback();
                return;
            }

            const current_room_id = cardStatusRows[0].current_room_id;

            if (current_room_id === 1){ //入室していないとき
                await connection.query('INSERT INTO AccessLogs (mac_address, room_id, action) VALUES (?, ?, ?)', [mac_address, room_id, 'entry']); //入室ログ追加
                await connection.query('UPDATE CardStatus SET current_room_id = ? WHERE mac_address = ?', [room_id, mac_address]); //どの部屋にいるか更新(このときupdated_timeは"ON UPDATE CURRENT_TIMESTAMP"により，このUPDATE文実行時のタイプスタンプに自動で更新される．)
                res.status(200).json({ message: 'Entry the room' });
            } else { //ユーザがすでに入室しているとき
                if (current_room_id === room_id) {//すでにその場所にいる場合
                    await connection.query('UPDATE CardStatus SET current_room_id = ?, updated_time = NOW() WHERE mac_address = ?', [room_id, mac_address]); //最終確認時間updated_timeを更新
                    res.status(200).json({ message: 'Staying the room'});
                } else { //他の場所にいる場合
                    let stayDuration = 0;
                    const [entryLog] = await connection.query('SELECT access_time FROM AccessLogs WHERE mac_address = ? AND room_id = ? AND action = ? ORDER BY access_time DESC LIMIT 1', [mac_address, current_room_id, 'entry']); //今回の退室と対応する入室ログを抽出する．
                    if (entryLog.length > 0) {
                        const entryTime = new Date(entryLog[0].access_time); //入室時間を格納
                        const stayDuration = Math.floor((currentTime - entryTime) / 1000 / 60); //滞在時間を計算
                        console.log(`Stay Duration: ${stayDuration} minutes`); //滞在時間を表示

                        const [stayTimeRows] = await connection.query('SELECT total_stay_duration, threshold_exceeded FROM StayTime WHERE mac_address = ?', [mac_address]); //現在の滞在時間を抽出
                        if (stayTimeRows.length > 0) { //滞在時間に今回の滞在時間を加算する処理．
                            const totalStayDuration = stayTimeRows[0].total_stay_duration + stayDuration;
                            const thresholdExceeded = totalStayDuration > 9600;

                            await connection.query('UPDATE StayTime SET total_stay_duration = ?, threshold_exceeded = ? WHERE mac_address = ?', [totalStayDuration, thresholdExceeded, mac_address]);

                            if (thresholdExceeded && !stayTimeRows[0].threshold_exceeded) { //今回初めてしきい値を超えた場合
                                // 以下は廃止したメール送信機能．
                                // const [userRows] = await connection.query('SELECT email FROM Users WHERE user_id = (SELECT user_id FROM ICCards WHERE card_id = ?)', [card_id]);
                                // if (userRows.length > 0) {
                                //     const userEmail = userRows[0].email;
                                //     sendWarningEmail(card_id, userEmail, totalStayDuration);
                                // }
                                console.log("Stay Duration exceeded the threshold.")
                            }
                        }
                    } 
                    await connection.query('INSERT INTO AccessLogs (mac_address, room_id, action) VALUES (?, ?, ?)', [mac_address, current_room_id, 'exit']); //退室ログ追加
                    await connection.query('INSERT INTO AccessLogs (mac_address, room_id, action) VALUES (?, ?, ?)', [mac_address, room_id, 'entry']); //入室ログ追加
                    await connection.query('UPDATE CardStatus SET current_room_id = ? WHERE mac_address = ?', [room_id, mac_address]); //どの部屋にいるか更新(このときupdated_timeは"ON UPDATE CURRENT_TIMESTAMP"により，このUPDATE文実行時のタイプスタンプに自動で更新される．)
                    res.status(200).json({ message: 'Exited room and Entry room', stayDuration });
                }
            }

            await connection.commit();

            wss.clients.forEach(client => {
                if (client.readyState === client.OPEN) {
                    const message = JSON.stringify({
                        mac_address,
                        current_room_id: room_id
                    });
                    console.log(`Sending message: ${message}`);
                    client.send(message);
                }
            });
        } catch (err) {
            await connection.rollback();
            throw err;
        } finally {
            connection.release();
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Internal Server Error', error: err.message });
    }
});

//AM4時になったら全員exitする．なお，合計滞在時間を記録しない．
const forceExitAllUsers = async () => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const [activeUsers] = await connection.query('SELECT mac_address, current_room_id FROM CardStatus WHERE current_room_id != 1');
        
        for (const user of activeUsers) {
            const { mac_address, current_room_id } = user;
            
            await connection.query('INSERT INTO AccessLogs (mac_address, room_id, action) VALUES (?, ?, ?)', [mac_address, current_room_id, 'exit']);
            await connection.query('UPDATE CardStatus SET current_room_id = 1 WHERE mac_address = ?', [mac_address]);
            await connection.query('UPDATE StayTime SET forgetCount = forgetCount + 1 WHERE mac_address = ?', [mac_address]);
        }
        
        await connection.commit();
        console.log('All users forced to exit and forgetCount incremented.');

        // WebSocketを通じてクライアントに通知
        wss.clients.forEach(client => {
            if (client.readyState === client.OPEN) {
                const message = JSON.stringify({
                    action: 'refresh'
                });
                console.log(`Sending message: ${message}`);  // 送信メッセージの確認
                client.send(message);
            }
        });
    } catch (err) {
        await connection.rollback();
        console.error('Error forcing users to exit:', err);
    } finally {
        connection.release();
    }
};


const rule = new schedule.RecurrenceRule();
rule.hour = 4;
rule.minute = 0;

const job = schedule.scheduleJob(rule, () => {
    forceExitAllUsers();
});


// 現在の入室状況を取得するエンドポイント
app.get('/api/status', async (req, res) => {
    try {
        const connection = await pool.getConnection(); // データベース接続の取得
        try {
            // 現在の入室状況を取得するクエリ
            const [rows] = await connection.query(
                `SELECT Users.username, Users.entry_year, Rooms.room_name, StayTime.total_stay_duration, StayTime.threshold_exceeded, StayTime.forgetCount, CardStatus.mac_address 
                FROM CardStatus 
                INNER JOIN MACaddress ON CardStatus.mac_address = MACaddress.mac_address 
                INNER JOIN Users ON MACaddress.user_id = Users.user_id
                INNER JOIN Rooms ON CardStatus.current_room_id = Rooms.room_id
                INNER JOIN StayTime ON CardStatus.mac_address = StayTime.mac_address
                ORDER BY Users.entry_year ASC`
            );
            res.json(rows); // 取得したデータをレスポンスとして返す
        } finally {
            connection.release(); // データベース接続を解放
        }
    } catch (err) {
        console.error(err); // エラーログの出力
        res.status(500).json({ message: 'Internal Server Error', error: err.message }); // エラーレスポンスの送信
    }
});


// 10分以上更新がなかったユーザを強制退室させる関数（滞在時間の加算も行う）
const checkInactiveUsers = async () => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // 退室状態でないユーザで、updated_timeから10分以上経過しているユーザを抽出
        const [inactiveUsers] = await connection.query(
            'SELECT mac_address, current_room_id FROM CardStatus WHERE current_room_id != 1 AND TIMESTAMPDIFF(MINUTE, updated_time, NOW()) >= 10'
        );
        const currentTime = new Date();

        for (const user of inactiveUsers) {
            const { mac_address, current_room_id } = user;

            // 退室前の部屋(current_room_id)の最新の入室ログを抽出
            const [entryLog] = await connection.query(
                'SELECT access_time FROM AccessLogs WHERE mac_address = ? AND room_id = ? AND action = ? ORDER BY access_time DESC LIMIT 1',
                [mac_address, current_room_id, 'entry']
            );
            let stayDuration = 0;
            if (entryLog.length > 0) {
                const entryTime = new Date(entryLog[0].access_time);
                // 入室時刻からの滞在時間を分単位で計算
                stayDuration = Math.floor((currentTime - entryTime) / 1000 / 60);
                console.log(`Stay Duration: ${stayDuration} minutes for user ${mac_address}`);

                // StayTimeテーブルから現在の累計滞在時間を取得し、今回の滞在時間を加算
                const [stayTimeRows] = await connection.query(
                    'SELECT total_stay_duration, threshold_exceeded FROM StayTime WHERE mac_address = ?',
                    [mac_address]
                );
                if (stayTimeRows.length > 0) {
                    const totalStayDuration = stayTimeRows[0].total_stay_duration + stayDuration;
                    const thresholdExceeded = totalStayDuration > 9600;
                    await connection.query(
                        'UPDATE StayTime SET total_stay_duration = ?, threshold_exceeded = ? WHERE mac_address = ?',
                        [totalStayDuration, thresholdExceeded, mac_address]
                    );
                    if (thresholdExceeded && !stayTimeRows[0].threshold_exceeded) {
                        // 閾値初超えの場合の処理（メール送信機能などがあれば）
                        console.log(`Stay Duration exceeded the threshold for user ${mac_address}`);
                    }
                }
            }
            // 退室ログの追加
            await connection.query(
                'INSERT INTO AccessLogs (mac_address, room_id, action) VALUES (?, ?, ?)',
                [mac_address, current_room_id, 'exit']
            );
            // CardStatusの更新：退室状態（部屋ID 1）に変更
            await connection.query(
                'UPDATE CardStatus SET current_room_id = ? WHERE mac_address = ?',
                [1, mac_address]
            );
            // // 忘れカウントの更新
            // await connection.query(
            //     'UPDATE StayTime SET forgetCount = forgetCount + 1 WHERE mac_address = ?',
            //     [mac_address]
            // );
            console.log(`User ${mac_address} exit due to inactivity. Stay duration added: ${stayDuration} minutes.`);
        }

        await connection.commit();

        // WebSocketでクライアントに通知
        wss.clients.forEach(client => {
            if (client.readyState === client.OPEN) {
                const message = JSON.stringify({ action: 'refresh' });
                client.send(message);
            }
        });
    } catch (err) {
        await connection.rollback();
        console.error('Error in checkInactiveUsers:', err);
    } finally {
        connection.release();
    }
};

// 毎分0秒に上記処理を実行するスケジュールジョブ（必要に応じて間隔を調整）
const inactivityRule = new schedule.RecurrenceRule();
inactivityRule.second = 0;
const inactivityJob = schedule.scheduleJob(inactivityRule, () => {
    checkInactiveUsers();
});



//月が更新されたら全員exitするかつ月終わりに合計滞在時間をリセットする
//月が変わったかを確認する関数
const resetMonthlyStayTime = async () => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        await connection.query('UPDATE StayTime SET total_stay_duration = 0, threshold_exceeded = 0');
        await connection.commit();
        console.log('Monthly stay time reset.');
    } catch (err) {
        await connection.rollback();
        console.error('Error resetting monthly stay time:', err);
    } finally {
        connection.release();
    }
};

const monthlyRule = new schedule.RecurrenceRule();
monthlyRule.date = 1; // 毎月1日
monthlyRule.hour = 0;
monthlyRule.minute = 0;

const monthlyJob = schedule.scheduleJob(monthlyRule, () => {
    forceExitAllUsers()
        .then(resetMonthlyStayTime)
        .catch(err => console.error('Error in monthly reset:', err));
});



// WebSocket接続のイベント処理
wss.on('connection', (ws) => {
    console.log('A client connected');

    ws.on('message', (message) => {
        console.log('Message received from client:', message);
    });

    ws.on('close', () => {
        console.log('A client disconnected');
    });
});

// サーバの起動
const port = process.env.APP_PORT || 3000;
server.listen(port, () => {
    console.log(`Server is running on port ${port}`);  // サーバ起動時にログを出力
});