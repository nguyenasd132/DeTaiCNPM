# KẾ HOẠCH XÂY DỰNG & LẬP TRÌNH PHẦN MỀM — HỆ THỐNG AN TÂM (NHÓM 5 NGƯỜI)

- **Thời gian thực hiện:** `19/11/2026` → `04/12/2026` (**16 ngày**, hoàn thành bàn giao cuối ngày **04/12/2026**).
- **File Sheet tiến độ tương tác:** [Ke_hoach_va_Tien_do_An_Tam.xlsx](Ke_hoach_va_Tien_do_An_Tam.xlsx) *(có thể mở bằng Excel hoặc import trực tiếp lên Google Sheets để cả nhóm tự điền tên chọn vị trí thành viên số 1 → số 5 và cập nhật tiến độ hằng ngày)*.

---

## 1. Phạm vi & Các hạng mục ĐÃ CÓ SẴN (Không làm lại)

Để tập trung tối đa thời gian vào việc **code phần mềm** và **kiểm thử hoàn chỉnh** trước ngày **04/12/2026**, nhóm thống nhất **bỏ qua 3 khâu đã hoàn tất**:

1. **Không khảo sát nghiệp vụ lại:** Quy trình 4 vai trò (Bệnh nhân, Bác sĩ, Điều dưỡng, Trưởng bệnh viện), luồng đặt lịch theo buổi (Sáng/Chiều) cấp STT tự động và bộ Use Case đã chốt.
2. **Không thiết kế hay làm Database lại:** Nhóm trưởng đã hoàn thành sẵn toàn bộ cơ sở dữ liệu PostgreSQL 16 (17 bảng, 12 cột JSONB, file migration, dữ liệu mẫu 7 chuyên khoa, 7 bác sĩ, 2 điều dưỡng, 200 giường bệnh) kèm Docker Compose.
3. **Không thiết kế giao diện (UI/UX) lại:** Bộ quy chuẩn màu sắc, phông chữ và bố cục Desktop/Mobile đã cố định; các thành viên chỉ sử dụng lại bộ quy chuẩn đó để code thẳng các màn hình.

---

## 2. Phân công công việc cho 5 thành viên (Tự chọn số ở Sheet 1)

| Mã | Vị trí | Nhóm công việc chính | Phạm vi code & Kiểm thử phụ trách | Số task |
| :--- | :--- | :--- | :--- | :---: |
| **TV-01** | **Thành viên số 1 (Nhóm trưởng)** | **Hạ tầng nền & Kiểm thử toàn hệ thống** *(Đã xong DB)* | Đưa DB có sẵn & Docker Compose lên GitHub; dựng khung xác thực/phân quyền (`middleware`), khung test (`Vitest + Supertest`); viết bộ test tự động Backend; review & merge Pull Request; **kiểm thử toàn diện 13+ kịch bản (4 vai trò)** trên Desktop/Mobile, báo lỗi & chốt nghiệm thu ngày `04/12`. | 6 |
| **TV-02** | **Thành viên số 2** | **Tài khoản, Công khai & Cổng Bệnh nhân (Đặt lịch STT & Hồ sơ)** | **Backend:** `auth.routes.ts`, `auth.service.ts`, `public.routes.ts`, `notification.routes.ts`, `patient.routes.ts` (phần đặt lịch/hồ sơ), `appointment.service.ts`.<br>**Frontend:** `LoginPage`, `RegisterPage`, `DoctorsDirectoryPage`, `HelpCenterPage`, `PatientHomePage`, `BookingWizardPage` (3 luồng), `MyAppointmentsPage`, `HealthProfilePage`. | 6 |
| **TV-03** | **Thành viên số 3** | **Cổng Bác sĩ & Trang Kết quả khám** | **Backend:** `doctor.routes.ts`, `record.service.ts`, `allergy.ts` (đối chiếu dị ứng/bệnh nền), `invoice.formatter.ts` (tách hóa đơn viện phí & thuốc, hẹn tái khám, lịch trực).<br>**Frontend:** `DoctorQueuePage`, `DoctorSchedulePage`, `DoctorExamPage` (kê đơn có cảnh báo dị ứng), `ExamResultsPage` (trang xem & in kết quả của Bệnh nhân). | 6 |
| **TV-04** | **Thành viên số 4** | **Cổng Điều dưỡng & Thanh toán Bệnh nhân** | **Backend:** `nurse.routes.ts`, `payment.service.ts` (thanh toán QR/Tiền mặt, xác nhận thu tiền nguyên tử, phát thuốc trừ tồn kho), `bed.service.ts` (điều phối giường nội trú).<br>**Frontend:** `NurseReceptionPage` (Check-in, Walk-in, Đo sinh hiệu Triage/BMI), `BillingPage` (thanh toán phía Bệnh nhân), `NurseCashierPage`, `NurseBedsPage`. | 6 |
| **TV-05** | **Thành viên số 5** | **Khung UI dùng chung & Cổng Trưởng bệnh viện** | **Frontend nền:** `AppShell` (Desktop/Mobile), `components/ui/*`, `components/charts/*`, `lib/api.ts`.<br>**Backend:** `admin.routes.ts`, `admin.service.ts` (Dashboard KPI, so sánh 7 ngày, công suất giường theo khoa, doanh thu, CRUD danh mục, xuất CSV).<br>**Frontend Quản lý:** `AdminDashboardPage`, `AdminReportsPage`, `AdminAppointmentsPage`, `AdminPatientsPage`, `AdminRecordsPage`, `AdminFacilitiesPage`, `AdminStaffPage`, `AdminCatalogPage`. | 6 |

> **Lưu ý tránh xung đột code:** 4 thành viên code (`TV-02` đến `TV-05`) chia tách rõ theo cặp thư mục Backend + Frontend riêng. Riêng `TV-05` hoàn thành bộ khung `AppShell` và `components/ui/*` trong 3 ngày đầu để `TV-02`, `TV-03`, `TV-04` lắp trang ngay mà không trùng file.

---

## 3. Lộ trình thực hiện theo 4 giai đoạn (19/11/2026 – 04/12/2026)

### Giai đoạn 1: Khởi tạo môi trường, Khung nền & UI dùng chung (`19/11 – 21/11/2026` — 3 ngày)
- **TV-01 (Nhóm trưởng):** Đưa DB PostgreSQL 16 có sẵn + `docker-compose.yml` lên GitHub; tạo nhánh chuẩn; hoàn thiện `middleware/auth.ts`, `validate.ts`, `errorHandler.ts` và khung test `Vitest + Supertest`.
- **TV-05:** Code xong khung bố cục `AppShell` (Desktop + Mobile bottom nav), các UI component dùng chung (`Button`, `Card`, `Table`, `Modal`, `StatusBadge`, `Toast`, `QrCodeBox`) và `lib/api.ts`.
- **TV-02:** Code xong Backend Đăng nhập/Đăng ký/Đổi mật khẩu + mở nhánh cho phân hệ Bệnh nhân.
- **TV-03 & TV-04:** Clone code, khởi chạy DB sẵn qua Docker, đọc cấu trúc bảng liên quan phân hệ của mình và dựng bộ khung route/service nhánh riêng.

### Giai đoạn 2: Code toàn bộ Backend API nghiệp vụ (`22/11 – 26/11/2026` — 5 ngày)
- **TV-02:** Hoàn thiện API Công khai, Thông báo, Đặt lịch 3 luồng theo buổi + cấp STT chống trùng, Đổi/Hủy lịch giữ nguyên STT, Hồ sơ dị ứng/bệnh nền (JSONB).
- **TV-03:** Hoàn thiện API Hàng đợi theo STT, Gọi số tiếp theo, Lưu bệnh án (JSONB), Kê đơn cảnh báo dị ứng tự động, Công bố kết quả tách 2 hóa đơn, Đặt tái khám và Quản lý lịch trực.
- **TV-04:** Hoàn thiện API Check-in, Đăng ký vãng lai (Walk-in + ưu tiên), Lưu sinh hiệu Triage (tính BMI) & BHYT, Thanh toán QR/Tiền mặt, Thu ngân xác nhận mở khóa đơn thuốc, Phát thuốc trừ kho và Điều phối giường bệnh.
- **TV-05:** Hoàn thiện API Dashboard thống kê (4 KPI, biểu đồ 7 ngày vs 7 ngày trước, công suất giường từng khoa, doanh thu), CRUD danh mục (Khoa, Phòng, Giường, Nhân sự, Lịch trực, Thuốc, Dịch vụ) và Xuất báo cáo CSV.
- **TV-01 (Nhóm trưởng):** Song song viết và chạy bộ Test tự động Backend cho luồng Đặt lịch/STT, Dị ứng/Bệnh án (`22–26/11`), Thanh toán/Giường/Phân quyền (`25–28/11`).

### Giai đoạn 3: Code Frontend các cổng vai trò & Ghép nối API (`27/11 – 01/12/2026` — 5 ngày)
- **27/11 – 29/11:**
  - **TV-02:** Trang Đăng nhập (kèm nút chọn nhanh Demo), Đăng ký, Tra cứu bác sĩ công khai, Trang chủ Bệnh nhân & Đặt lịch 3 luồng.
  - **TV-03:** Hàng đợi Bác sĩ (`DoctorQueuePage`) & Lịch trực (`DoctorSchedulePage`).
  - **TV-04:** Tiếp đón & Đo sinh hiệu (`NurseReceptionPage`) + Thanh toán của Bệnh nhân (`BillingPage`).
  - **TV-05:** Dashboard biểu đồ (`AdminDashboardPage`) & Trang xuất báo cáo CSV (`AdminReportsPage`).
- **29/11 – 01/12:**
  - **TV-02:** Quản lý lịch hẹn (xem STT đang khám, đổi/hủy) & Hồ sơ sức khỏe.
  - **TV-03:** Màn hình Khám bệnh & Kê đơn cảnh báo dị ứng (`DoctorExamPage`) + Trang xem/in Kết quả & Đơn thuốc (`ExamResultsPage`).
  - **TV-04:** Thu ngân & Phát thuốc (`NurseCashierPage`) + Sơ đồ & Điều phối Giường bệnh (`NurseBedsPage`).
  - **TV-05:** 6 trang Quản trị danh mục & tra cứu toàn viện.
  - **TV-01 (Nhóm trưởng):** Review Pull Request, ghép code 4 nhánh vào `main` và kiểm tra build toàn hệ thống trên Docker.

### Giai đoạn 4: Kiểm thử toàn diện, Sửa lỗi & Nghiệm thu (`02/12 – 04/12/2026` — 3 ngày)
- **02/12/2026:** **TV-01 (Nhóm trưởng)** kiểm thử thực tế trọn bộ **13+ Test Cases** từ Bệnh nhân đặt lịch → Điều dưỡng check-in/đo sinh hiệu → Bác sĩ khám & cảnh báo dị ứng → Thanh toán QR/thu ngân & phát thuốc → Điều phối giường → Dashboard Trưởng bệnh viện trên cả Desktop và Mobile; lập danh sách lỗi (nếu có).
- **03/12/2026:** **TV-02, TV-03, TV-04, TV-05** sửa dứt điểm toàn bộ lỗi được ghi nhận từ kiểm thử.
- **04/12/2026 (Mốc hoàn thành):** **TV-01** kiểm thử hồi quy (Regression Test) lần cuối, xác nhận chạy ổn định 100% kịch bản trên Docker Compose và chốt bàn giao hoàn thành dự án.

---

## 4. Hướng dẫn sử dụng Sheet tiến độ (`Ke_hoach_va_Tien_do_An_Tam.xlsx`)

1. Tải file [Ke_hoach_va_Tien_do_An_Tam.xlsx](Ke_hoach_va_Tien_do_An_Tam.xlsx) lên **Google Drive → Mở bằng Google Trang tính (Google Sheets)** (hoặc dùng chung qua Excel/SharePoint) và chia sẻ quyền chỉnh sửa cho 5 thành viên.
2. Tại **Sheet 1 (`Chon_Thanh_Vien`)**:
   - Đọc mô tả nhiệm vụ của từng số (`Thành viên số 1` đến `Thành viên số 5`).
   - Mỗi thành viên tự chọn 1 số phù hợp rồi **điền Họ & Tên và MSSV/GitHub vào 2 ô màu vàng** ở dòng tương ứng (`C6:D10`).
   - Cột `Trạng thái nhận slot` tự động báo đã có người chọn để tránh 2 bạn chọn trùng cùng 1 số.
3. Tại **Sheet 2 (`Tien_Do_Chi_Tiet`)**:
   - Tên người phụ trách ở cột `F` tự động hiện theo tên bạn đã điền ở Sheet 1.
   - Cuối mỗi ngày, từng thành viên chọn **Trạng thái** từ danh sách xổ xuống và nhập **Tiến độ (%)** cho các task của mình.
4. Tại **Sheet 3 (`Lich_Gantt_16_Ngay`)**:
   - Toàn bộ biểu đồ ngày (`19/11` → `04/12`) tự động hiển thị dấu `●` (đang thực hiện theo lịch) và chuyển sang `✓` (màu xanh) ngay khi task chuyển trạng thái **Hoàn thành**.
