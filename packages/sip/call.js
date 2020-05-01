import EventEmitter from 'eventemitter3'

class CallSip extends EventEmitter {

    constructor(client, {description, id}) {
        super()
        this.client = client
        this.tracks = {}
        // TODO: Refactor description.endpoint to description.extension
        this.description = description
        this.dialog = {
            fromTag: null,
            toTag: null,
        }
        this.id = id

        this.on('message', this.onMessage.bind(this))
    }


    accept() {
        this.on('trackAdded', this.onTrack.bind(this))
        this.session.accept({
            sessionDescriptionHandlerOptions: {
                constraints: this.app.media._getUserMediaFlags(),
            },
        })
    }


    hold() {
        this.session.hold({
            sessionDescriptionHandlerOptions: {
                constraints: this.app.media._getUserMediaFlags(),
            },
        })
        this.setState({hold: {active: true}})
    }


    incoming() {
        this.app.logger.debug(`${this}incoming call ${this.id} started`)

        this.state.number = this.session.assertedIdentity.uri.user
        this.state.name = this.session.assertedIdentity.displayName

        super.incoming()

        this.session.on('accepted', () => {
            this._start({message: this.translations.accepted})
        })

        this.session.on('bye', () => {
            this.setState({status: 'bye'})
            this._stop({message: this.translations[this.state.status]})
        })

        /**
        * The `failed` status is triggered when a call is rejected, but
        * also when an incoming calls keeps ringing for a certain amount
        * of time (60 seconds), and fails due to a timeout. In that case,
        * no `rejected` event is triggered and we need to kill the
        * call ASAP, so a new INVITE for the same call will be accepted by
        * the call module's invite handler.
        */
        this.on('failed', (message) => {
            if (typeof message === 'string') message = this.app.modules.sip.SIP.Parser.parseMessage(message, this.app.sip.ua)
            let reason = message.getHeader('Reason')
            let status = 'caller_unavailable'

            if (reason) reason = this._parseHeader(reason).get('text')

            if (reason === 'Call completed elsewhere') {
                status = 'answered_elsewhere'
            } else if (message.status_code === 480) {
                // The accepting party terminated the incoming call.
                status = 'callee_unavailable'
            }

            super.terminate(status)
        })

        this.on('reinvite', (session) => {
            this.app.logger.debug(`${this}<event:reinvite>`)
            // Seems to be a timing issue in SIP.js. After a transfer,
            // the old name is keps in assertedIdentity, unless a timeout
            // is added.
            setTimeout(() => {
                this.state.name = session.assertedIdentity.uri.user
                this.state.number = session.assertedIdentity.uri.user
            }, 0)
        })
    }


    async onMessage(message) {
        if (message.method === 'INVITE') {
            if (message.status === 'Unauthorized') {
                if (message.digest) {
                    const inviteMessage = this.client.protocol.outgoing({
                        callId: this.id,
                        content: this.pc.localDescription.sdp,
                        digest: message.digest,
                        extension: this.description.endpoint,
                        method: 'INVITE',
                    })

                    this.client.socket.send(inviteMessage)

                    const ackMessage = this.client.protocol.outgoing({
                        callId: this.id,
                        cseq: message.cseq,
                        extension: this.description.endpoint,
                        method: 'ACK',
                    })

                    this.client.socket.send(ackMessage)
                }
            } else if (message.status === 'OK') {
                this.dialog.to = message.header.To.tag
                await this.pc.setRemoteDescription({sdp: message.content, type: 'answer'})

                const ackMessage = this.client.protocol.outgoing({
                    callId: this.id,
                    cseq: message.cseq,
                    extension: this.description.endpoint,
                    method: 'ACK',
                    transport: 'ws',
                })

                this.client.socket.send(ackMessage)
            }
        } else if (message.method === 'BYE') {
            console.log("BUEEEE", this.tag)
        } else if (message.method === 'MESSAGE') {
            this.emit('call:message', JSON.parse(message.content))
        }
    }


    onTrack(track) {
        const receivers = this.pc.getReceivers()
        if (!receivers.length) return

        const newTracks = []
        for (const receiver of receivers) {
            if (!this.tracks[receiver.track.id]) {
                this.tracks[receiver.track.id] = receiver.track
                newTracks.push(receiver.track)
            }
        }
        if (!newTracks.length) return

        for (const track of newTracks) {
            const newStream = new MediaStream()
            newStream.addTrack(track)
            this.emit('track', newStream, track)
        }
    }


    async outgoing(localStream) {
        this.pc = new RTCPeerConnection({
            iceServers: this.client.stun.map((i) => ({urls: i})),
            sdpSemantics:'unified-plan',
        })

        this.pc.ontrack = this.onTrack.bind(this)
        this.pc.onicegatheringstatechange = () => {
            // Send the invite once the candidates are part of the sdp.
            if (this.pc.iceGatheringState === 'complete') {
                this.client.invite(this)
            }
        }

        for (const track of localStream.getTracks()) {
            this.pc.addTrack(track, localStream)
        }

        const offer = await this.pc.createOffer()
        this.pc.setLocalDescription(offer)


        // this.setState({stats: {callId: this.session.request.call_id}})
        // this.session.on('trackAdded', this.onTrack.bind(this))
        // this.session.on('accepted', () => {
        //     this.app.logger.debug(`${this}<event:accepted>`)
        //     this._start({message: this.translations.accepted})
        // })
        // this.session.on('bye', () => {
        //     this.app.logger.debug(`${this}<event:bye>`)
        //     super.terminate('bye')
        // })

        // /**
        // * Play a ringback tone on the following status codes:
        // * 180: Ringing
        // * 181: Call is Being Forwarded
        // * 182: Queued
        // * 183: Session in Progress
        // */
        // this.session.on('progress', (e) => {
        //     this.app.logger.debug(`${this}<event:progress>`)
        //     if ([180, 181, 182, 183].includes(e.status_code)) {
        //         this.app.sounds.ringbackTone.play()
        //     }
        // })

        // // Blind transfer.
        // this.session.on('refer', () => {
        //     this.app.logger.debug(`${this}<event:refer>`)
        //     this.session.bye()
        // })

        // // The user is being transferred; update the caller info
        // // from the P-Asserted-Identity header.
        // this.session.on('reinvite', (session) => {
        //     this.app.logger.debug(`${this}<event:reinvite>`)
        //     // Seems to be a timing issue in SIP.js. After a transfer,
        //     // the old name is keps in assertedIdentity, unless a timeout
        //     // is added.
        //     setTimeout(() => {
        //         if (session.assertedIdentity) {
        //             this.state.name = session.assertedIdentity.uri.user
        //             this.state.number = session.assertedIdentity.uri.user
        //         } else {
        //             this.state.name = session.remoteIdentity.uri.user
        //             this.state.number = session.remoteIdentity.uri.user
        //         }
        //     }, 0)
        // })

        // this.session.on('failed', (message) => {
        //     let status = 'callee_unavailable'
        //     // 486 - Busy here; Callee is busy.
        //     // 487 - Request terminated; Request has terminated by bye or cancel.
        //     if (message.status_code === 486) {
        //         status = 'callee_busy'
        //     } else if (message.status_code === 487) {
        //         status = 'caller_unavailable'
        //     }

        //     super.terminate(status)
        // })
    }


    terminate() {
        const byeMessage = this.client.protocol.outgoing({
            callId: this.id,
            extension: this.description.endpoint,
            method: 'BYE',
            toTag: this.dialog.toTag,
            transport: 'ws',
        })

        console.log(byeMessage)

        this.client.socket.send(byeMessage)
    }


    transfer(targetCall) {
        if (typeof targetCall === 'string') {
            this.session.refer(`sip:${targetCall}@ca11.app`)
        } else {
            this.session.refer(targetCall.session)
        }
    }


    unhold() {
        if (this.session) {
            this.session.unhold({
                sessionDescriptionHandlerOptions: {
                    constraints: this.app.media._getUserMediaFlags(),
                },
            })
            this.setState({hold: {active: false}})
        }
    }
}

export default CallSip
