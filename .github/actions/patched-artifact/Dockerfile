FROM node:24.22.1-bookworm@sha256:f9b3548b20b15b705b66aeecaeac7dd690c73d5e4661357aac02e60e3d38c88a
RUN mkdir -p /opt/official-artifact
COPY admission.mjs /opt/official-artifact/admission.mjs
RUN node /opt/official-artifact/admission.mjs
RUN true \
 && curl --fail --silent --show-error --location https://raw.githubusercontent.com/actions/upload-artifact/cf430e030ddbb5b0abf93d22962f4752f3646cd9/dist/upload/index.js --output /opt/official-artifact/upload.mjs \
 && printf '%s\n' 'c0e58b240360573e6d6c82ea1bb22deff4f85883e00211a52bd27822c3a22617  /opt/official-artifact/upload.mjs' | sha256sum --check \
 && curl --fail --silent --show-error --location https://raw.githubusercontent.com/actions/download-artifact/9000827ccba6bdab643e8b6fd33ac0654aef8333/dist/index.js --output /opt/official-artifact/download.mjs \
 && printf '%s\n' '7834b909df0fd656f5ac1c4c4ab4ee3b5e2673e4f4f763549d8abbca16bc5bbe  /opt/official-artifact/download.mjs' | sha256sum --check
COPY entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/bin/bash", "/entrypoint.sh"]
