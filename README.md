# WA CRM pribadi — OneSender

CRM satu pengguna: kelola kontak, impor CSV, catat persetujuan, tahap prospek, aktivitas dan tindak lanjut manual; buat kampanye teks, jadwalkan, jeda/lanjutkan, dan pantau hasil pengajuan ke OneSender. Tidak ada pendaftaran publik atau tagihan SaaS.

## Memperbarui aplikasi yang sudah berjalan

1. **Backup volume** `wa_crm_data` melalui Coolify sebelum mengganti kode. Database ada di `/data/crm.db`; backup harus mencakup file SQLite beserta WAL saat aplikasi aktif, atau ambil backup ketika aplikasi dihentikan. Jangan hapus volume maupun membuat layanan aplikasi kedua yang memakai volume sama.
2. Salin isi ZIP ini ke akar repo `waba`, timpa file lama. Commit dan Push origin memakai GitHub Desktop; lalu Redeploy aplikasi **yang sama** di Coolify. Tidak perlu mengganti environment variable, domain, atau membuat layanan baru.
3. Buka halaman Ringkasan dan Kontak. Saat aplikasi pertama kali dimulai, kolom CRM baru ditambahkan otomatis ke database lama. Kontak, consent, opt-out, kampanye, dan antrean lama tetap ada. Jika muncul masalah, rollback image sebelumnya dan pulihkan backup volume bila diperlukan.

Pada tahap CRM ini, klik nama kontak untuk mengubah tahap (baru/dihubungi/negosiasi/pelanggan/selesai), mencatat aktivitas, dan mengatur tanggal tindak lanjut dalam WIB. Jadwal yang lewat muncul di Ringkasan. Jadwal tidak mengirim pesan otomatis; kosongkan tanggal jika tugas sudah selesai. Formulir profil tidak mengubah izin/nomor secara diam-diam. Kontak opt-out tetap tidak menerima kampanye.

## Pesan masuk (StarSender)

Riwayat aktivitas adalah catatan yang ditulis manual. Riwayat chat WhatsApp memerlukan webhook terpisah. Kode ini mendukung **pesan teks masuk StarSender V3** dengan format `from`, `message`, dan `timestamp` yang tercantum dalam [dokumentasi webhook StarSender](https://docs.starsender.online/docs/webhook/). OneSender tetap digunakan untuk blast, tetapi penerimaan webhook OneSender belum diaktifkan karena format payload-nya perlu dikonfirmasi dari perangkat Anda.

1. Tambahkan variabel **Production** `INBOUND_WEBHOOK_TOKEN` di Coolify dengan nilai acak minimal 32 karakter; misalnya buat lewat `openssl rand -hex 32` di terminal pribadi. Jangan taruh nilainya di GitHub, tangkapan layar, atau README.
2. Setelah upload ZIP terbaru ke repo, Push origin lalu **Redeploy aplikasi yang sama**. Pastikan halaman Ringkasan menampilkan kartu `Perlu ditindaklanjuti` dan menu `Pesan masuk`; jika masih muncul `Mulai dari sini`, Coolify masih menjalankan commit lama.
3. Di pengaturan webhook **device StarSender**, isi endpoint `https://taysriulqurani.id/webhooks/starsender/NILAI_TOKEN_ANDA` pada slot webhook pesan masuk yang kosong, lalu simpan. Jangan mengganti webhook lain yang sudah digunakan. Domain harus mengarah ke layanan `app` port 3000, path domain Coolify kosong (root `/`). Gunakan HTTPS.
4. Kirim pesan teks dari nomor lain ke device StarSender; cek menu **Pesan masuk** dan buka kontak tersebut. Nomor yang belum dikenal masuk sebagai kontak **tanpa izin blast**. Pesan kampanye yang baru dikirim dari aplikasi juga tampil pada halaman kontak berlabel “diterima gateway”. Pesan lama di WhatsApp maupun pesan keluar yang sudah ada sebelum pembaruan ini tidak dapat diimpor otomatis.

Jika webhook StarSender tidak dipakai atau belum tersedia, kosongkan variabel `INBOUND_WEBHOOK_TOKEN`; endpoint akan nonaktif. Jangan menyalin URL rahasia itu ke chat. Webhook pesan masuk tidak otomatis membalas pesan maupun mengubah consent. Untuk OneSender, ambil contoh JSON webhook dari pengaturannya (hapus nomor dan kunci) sebelum menambah adaptor.

## Cara deploy di Coolify

1. Gunakan repository GitHub **public**. Jika repository `waba` milik Anda masih kosong, salin **isi** folder `wa-crm` ke akar repository: `compose.yaml`, `Dockerfile`, `package.json`, `src/`, dan file lainnya. Jika sudah ada proyek lain di `waba`, gunakan repository baru agar file proyek lain tidak tertimpa. Jangan unggah `.env`, database, ekspor kontak, atau tangkapan layar berisi data pribadi.
2. Di GitHub Desktop buka repository `waba` → **Show in Explorer** → salin file proyek → kembali ke GitHub Desktop → isi pesan commit → **Commit to main** → **Push origin**. Pastikan file yang berubah tidak memuat API key sebelum commit.
3. Di Coolify pilih **Public Git Repository**, masukkan URL repository public dan branch `main`. Pilih build pack **Docker Compose** dan file `compose.yaml` pada akar repository. Tidak perlu deploy key atau GitHub App.
4. Atur environment variable dari `.env.example` lewat Coolify. `SESSION_SECRET` harus acak dan tetap sama setelah redeploy; contoh membuatnya: `openssl rand -hex 32`. Gunakan API URL **HTTPS** yang benar-benar valid dan API key dari halaman device OneSender. `STARSENDER_DEVICE_API_KEY` opsional, diambil dari menu device StarSender, bukan key akun. Jangan masukkan API key ke GitHub atau chat.
5. Arahkan domain melalui Coolify ke port aplikasi `3000` dan aktifkan HTTPS. Simpan volume `wa_crm_data` saat redeploy dan siapkan backup volume tersebut secara berkala.
6. Deploy lalu buka `/login`. Untuk revisi manual: commit dan **Push origin** di GitHub Desktop, kemudian tekan **Redeploy** di Coolify.

VPS 4 vCPU/8 GB cukup sebagai titik awal untuk satu pengguna. Kode mengirim **satu pesan per interval** (minimal 15 detik), hanya ke kontak yang `consented` dan belum opt-out. Tidak ada janji keamanan nomor dari pemblokiran; patuhi izin penerima dan kebijakan penyedia.

## Impor dan kampanye

CSV UTF-8 dengan header `name,phone,tag,consent`. Nomor Indonesia `08...` diubah menjadi `628...`; nomor internasional dengan kode negara juga diterima. Isi `consent` dengan `yes`/`true`/`1` **hanya jika penerima sudah mengizinkan pesan WhatsApp**. Impor tidak otomatis memberi izin. Duplikat nomor diperbarui tanpa menghapus status berhenti berlangganan. Kolom tag opsional. Teks kampanye mendukung `{{name}}`. Kampanye memilih semua kontak berizin atau satu tag. Tinjau pratinjau dan jumlah penerima sebelum tombol Mulai.

Pilih OneSender atau StarSender untuk kampanye baru. Jika provider bermasalah, jeda kampanye dan pilih provider lain saat melanjutkan **sisa antrean**; ini tidak mengulang pesan sebelumnya. Respons sukses dicatat sebagai **diterima gateway**, bukan bukti tersampaikan ke WhatsApp. Jika request timeout atau respons tidak jelas, kampanye dijeda dan item berstatus `unknown`: jangan kirim ulang tanpa meninjau log perangkat untuk menghindari duplikasi. Kesalahan jelas disimpan sebagai `failed` dan tidak diulang otomatis. `STOP` harus diproses manual dengan menandai kontak opt-out; webhook tidak mengubah status izin otomatis.

## Batas versi awal

Satu API URL/key OneSender dan satu device StarSender opsional. Tambah sender lain dan sinkronisasi webhook OneSender di tahap berikutnya setelah formatnya diverifikasi. Tidak ada pengiriman gambar/dokumen, sinkronisasi Chatwoot, dashboard deliverability, atau billing. Penyimpanan database SQLite ada di volume Docker, sehingga **volume wajib dipertahankan**. Ubah kata sandi admin melalui Coolify lalu redeploy; sesi lama tetap hidup maksimal 7 hari atau sampai `SESSION_SECRET` diganti.

## Uji lokal

Butuh Node.js 24+. Jalankan `npm test`, lalu isi environment dari `.env.example` secara aman dan jalankan `npm start`. Jangan memakai `http://` pada URL OneSender yang membawa API key.
