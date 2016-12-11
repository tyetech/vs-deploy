/// <reference types="node" />

// The MIT License (MIT)
// 
// vs-deploy (https://github.com/mkloubert/vs-deploy)
// Copyright (c) Marcel Joachim Kloubert <marcel.kloubert@gmx.net>
// 
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to
// deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
// sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
// 
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
// 
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
// FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
// DEALINGS IN THE SOFTWARE.

import * as deploy_contracts from '../contracts';
import * as deploy_helpers from '../helpers';
import * as deploy_objects from '../objects';
import * as FS from 'fs';
import * as Net from 'net';
import * as ZLib from 'zlib';


interface DeployTargetRemote extends deploy_contracts.DeployTarget {
    hosts?: string | string[];
}

interface RemoteFile {
    data?: string;
    isCompressed?: boolean;
    name: string;
}

class RemotePlugin extends deploy_objects.DeployPluginBase {
    constructor(ctx: deploy_contracts.DeployContext) {
        super(ctx);
    }

    public deployFile(file: string, target: DeployTargetRemote, opts?: deploy_contracts.DeployFileOptions): void {
        if (!opts) {
            opts = {};
        }

        let me = this;

        let hosts = deploy_helpers.asArray(target.hosts)
                                  .map(x => deploy_helpers.toStringSafe(x))
                                  .filter(x => x);

        let completed = (err?: any) => {
            if (opts.onCompleted) {
                opts.onCompleted(me, {
                    error: err,
                    file: file,
                    target: target,
                });
            }
        };

        try {
            if (opts.onBeforeDeploy) {
                opts.onBeforeDeploy(me, {
                    file: file,
                    target: target,
                });
            }

            let relativePath = deploy_helpers.toRelativePath(file);
            if (false === relativePath) {
                completed(new Error(`Could not get relative path for '${file}' file!`));
                return;
            }

            while (0 == relativePath.indexOf('/')) {
                relativePath = relativePath.substr(1);
            }

            if (!relativePath) {
                completed(new Error(`Relative path for '${file}' file is empty!`));
                return;
            }

            FS.readFile(file, (err, data) => {
                if (err) {
                    completed(err);
                    return;
                }

                let remoteFile: RemoteFile = {
                    name: <string>relativePath,
                };

                ZLib.gzip(data, (err, compressedData) => {
                    if (err) {
                        completed(err);
                        return;
                    }

                    remoteFile.isCompressed = compressedData.length < data.length;
                    let dataToSend = remoteFile.isCompressed ? compressedData : data;

                    try {
                        remoteFile.data = dataToSend.toString('base64');
                    }
                    catch (e) {
                        completed(e);
                        return;
                    }

                    let json: Buffer;
                    try {
                        json = new Buffer(JSON.stringify(remoteFile), 'utf8');
                    }
                    catch (e) {
                        completed(e);
                        return;
                    }

                    let hostsTodo = hosts.map(x => x);
                    let deployNext: () => void;
                    deployNext = () => {
                        if (hostsTodo.length < 1) {
                            completed();
                            return;
                        }

                        let h = hostsTodo.pop();
                        if (!h) {
                            completed();
                            return;
                        }

                        let hostCompleted = (err?: any) => {
                            deployNext();
                        };

                        try {
                            let addr = h;
                            let port = deploy_contracts.DEFAULT_PORT;
                            
                            let separator = h.indexOf(':');
                            if (separator > -1) {
                                addr = deploy_helpers.toStringSafe(h.substr(0, separator).toLowerCase().trim(),
                                                                deploy_contracts.DEFAULT_HOST);

                                port = parseInt(deploy_helpers.toStringSafe(h.substr(separator + 1).trim(),
                                                                            '' + deploy_contracts.DEFAULT_PORT));
                            }

                            let client = new Net.Socket();

                            client.on('error', (err) => {
                                hostCompleted(err);
                            });

                            client.connect(port, addr, (err) => {
                                if (err) {
                                    hostCompleted(err);
                                    return;
                                }

                                try {
                                    let dataLength = Buffer.alloc(4);
                                    dataLength.writeUInt32LE(json.length, 0);

                                    client.write(dataLength);
                                    client.write(json);

                                    try {
                                        client.destroy();
                                    }
                                    catch (e) {
                                        me.context.log(`RemotePlugin.deployFile().client.connect(): ${deploy_helpers.toStringSafe(e)}`);
                                    }

                                    hostCompleted();
                                }
                                catch (e) {
                                    hostCompleted(e);
                                }
                            });
                        }
                        catch (e) {
                            hostCompleted(e);
                        }
                    };

                    deployNext();
                });
            });
        }
        catch (e) {
            completed(e);
        }
    }
}

/**
 * Creates a new Plugin.
 * 
 * @param {deploy_contracts.DeployContext} ctx The deploy context.
 * 
 * @returns {deploy_contracts.DeployPlugin} The new instance.
 */
export function createPlugin(ctx: deploy_contracts.DeployContext): deploy_contracts.DeployPlugin {
    return new RemotePlugin(ctx);
}