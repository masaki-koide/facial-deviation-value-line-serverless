'use strict'

const crypto = require('crypto')
const request = require('request-promise-native')

const firebase = require('firebase-admin')
const serviceAccount = require('./serviceAccountKey.json')
firebase.initializeApp({
    credential: firebase.credential.cert(serviceAccount),
    databaseURL: process.env.firebaseDatabaseUrl
})
const database = firebase.database()
const usersRef = database.ref('users')

const lineReplyUri = 'https://api.line.me/v2/bot/message/reply'
const lineGetContentUri = 'https://api.line.me/v2/bot/message'
const faceDetectUri = 'https://api-us.faceplusplus.com/facepp/v3/detect'

module.exports.webhook = (event, context, callback) => {
    const body = JSON.parse(event.body)

    context.callbackWaitsForEmptyEventLoop = false

    // 署名が有効なものか検証する
    if (isValidSignature(event.headers['X-Line-Signature'], body)) {
        reply(body.events, callback)
    }
}

/**
 * 返信する
 * @param {Array} events イベント
 * @param {Function} callback コールバック
 */
function reply(events, callback) {
    events.forEach(async event => {
        // 画像が送信されてきた場合
        if (event.type === 'message' && event.message.type === 'image') {
            let messages
            try {
                // 送信された画像をbase64形式で取得
                const content = await getContentEncodedInBase64(event.message.id)
                // 画像から顔を検出する
                const faces = await detectFace(content)

                // 画像から顔を検出できなかった場合
                if (faces.length === 0) {
                    messages = createErrorMessage('写真から顔を検出できませんでした。')
                // 返信できるメッセージが5つまでのため
                } else if (faces.length > 5) {
                    messages = createErrorMessage('写真から6人以上の顔を検出しました。診断できるのは5人までです。')
                } else {
                    // 顔の検出結果をメッセージオブジェクトに変換
                    messages = createFacesAnalysisResultMessages(faces)
                }
            } catch (err) {
                console.log(err)
                messages = createErrorMessage('エラーが発生しました。しばらく待ってもう一度やり直してください。')
            } finally {
                replyMessages(event.replyToken, messages)
            }
        // フォローもしくはフォロー解除された場合
        } else if (event.type === 'follow' || event.type === 'unfollow') {
            const userId = event.source.userId
            const isFollowEvent = event.type === 'follow'
            const response = {
                statusCode: 200,
                body: JSON.stringify({}),
            }

            try {
                await updateUser(userId, isFollowEvent)
            } catch (err) {
                console.log(err)
            } finally {
                // イベントループを終了させる
                callback(null, response)
            }
        // その他のイベントはエラーメッセージで返す
        } else {
            const messages = createErrorMessage('診断したい写真を送ってね！')
            replyMessages(event.replyToken, messages)
        }
    })
}

/**
 * 署名が有効なものか検証する
 * @param {String} signature 署名
 * @param {Object} body リクエストボディ
 * @returns {Boolean} 有効な署名だったらtrueを返す
 */
function isValidSignature(signature, body) {
    return signature === crypto
        .createHmac('SHA256', process.env.lineChannelSecret)
        .update(Buffer.from(JSON.stringify(body)))
        .digest('base64')
}

/**
 * メッセージのコンテンツをbase64形式で取得する
 * @param {String} messageId メッセージID
 * @returns {Promise} base64形式のコンテンツでresolveされたPromiseオブジェクト、もしくはreject
 */
function getContentEncodedInBase64(messageId) {
    const options = {
        uri: `${lineGetContentUri}/${messageId}/content`,
        auth: {
            bearer: process.env.lineBearer
        },
        // データをバイナリで取得する
        encoding: null
    }

    return request(options)
        .then(response => {
            // base64形式にエンコード
            return response.toString('base64')
        })
        .catch(err => {
            console.log(err)
            return Promise.reject(new Error(err))
        })
}

/**
 * 画像から顔を検出し、結果を返す
 * @param {String} image base64エンコードされた画像
 * @return {Promise} 顔検出結果の配列でresolveされたPromiseオブジェクト、もしくはreject
 */
function detectFace (image) {
    const options = {
        method: 'POST',
        uri: faceDetectUri,
        form: {
            api_key: process.env.faceApiKey,
            api_secret: process.env.faceApiSecret,
            image_base64: image,
            return_attributes: 'gender,age,beauty'
        },
        json: true
    }

    return request(options)
        .then(response => {
            if (response.error_message) {
                return Promise.reject(response.error_message)
            }

            return response.faces
        })
        .catch(err => {
            console.log(err)
            return Promise.reject(new Error(err))
        })
}

/**
 * 顔の解析結果のメッセージオブジェクトの配列を生成する
 * @param {Array} faces 顔の検出オブジェクトの配列
 * @returns {Array} メッセージオブジェクトの配列
 */
function createFacesAnalysisResultMessages (faces) {
    const sortedFaces = faces.sort((a, b) => {
        if (a.face_rectangle.left === b.face_rectangle.left) {
            return 0
        } else if (a.face_rectangle.left < b.face_rectangle.left) {
            return -1
        }
        return 1
    })

    return sortedFaces.map((face, index) => {
        const attr = face.attributes
        const age = attr.age.value
        const gender = attr.gender.value === 'Male' ? '男性' : '女性'
        const beauty = gender === '男性' ? attr.beauty.male_score : attr.beauty.female_score
        // 見づらいがタブを入れないためには仕方ない
        const text = `${faces.length > 1 ? `左から${index + 1}人目\n` : ''}年齢: ${age}歳
性別: ${gender}
顔面偏差値: ${Math.round(beauty)}点(100点満点)`

        return {
            'type': 'text',
            'text': text
        }
    })
}

/**
 * エラーメッセージオブジェクトを生成する
 * @param {String} message エラーメッセージ
 * @returns {Object} エラーメッセージオブジェクト
 */
function createErrorMessage (message) {
    return [{
        'type': 'text',
        'text': message
    }]
}

/**
 * 返信する
 * @param {String} replyToken リプライトークン
 * @param {Array} messages メッセージオブエジェクトの配列
 * @return {Promise} Promiseオブジェクト
 */
function replyMessages (replyToken, messages) {
    const options =  {
        method: 'POST',
        uri: lineReplyUri,
        body: {
            replyToken: replyToken,
            messages: messages
        },
        auth: {
            bearer: process.env.lineBearer
        },
        json: true
    }

    return request(options)
        .then(() => {
            return
        })
        .catch(err => {
            console.log(err)
            return Promise.reject(new Error(err))
        })
}

/**
 * ユーザーのフォロー情報を更新する
 * @param {String} userId ユーザーID
 * @param {Boolean} isFollow フォローイベントならtrue、フォロー解除イベントならfalse
 * @return {Promise} Promiseオブジェクト
 */
function updateUser(userId, isFollowEvent) {
    const userRef = usersRef.child(userId)

    return userRef.update({
        isBlocked: !isFollowEvent,
        timestamp: firebase.database.ServerValue.TIMESTAMP
    }).catch(err => {
        console.log(err)
        return Promise.reject(new Error(err))
    })
}
